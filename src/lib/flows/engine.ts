/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, isExitMessage, resolveFallbackPolicy } from "./fallback";
import {
  foldKeywordText,
  isValidCollectedInput,
  isWithinBusinessHours,
  parseHeaderLines,
  readPath,
  varToText,
  waitDurationMs,
} from "./engine-match";
import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import { flowListensOn } from "./validate";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type CreateDealNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type EndNodeConfig,
  type GoToFlowNodeConfig,
  type HttpFetchNodeConfig,
  type WaitNodeConfig,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keyword match against a list of keywords. `contains` matches whole
 * words only: "oi" fires on "oi, tudo bem?" but not on "boa noite".
 * Case- and accent-insensitive by default. Stable enough that the v3
 * builder UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const fold = (v: string) => (cfg.case_sensitive ? v : foldKeywordText(v));
  const haystack = fold(text).trim();
  for (const raw of cfg.keywords) {
    if (!raw || !raw.trim()) continue;
    const needle = fold(raw).trim();
    if (matchType === "exact") {
      if (haystack === needle) return true;
      continue;
    }
    const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u");
    if (word.test(haystack)) return true;
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "create_deal" ||
    node_type === "http_fetch"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "wait"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end" || node_type === "go_to_flow";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  channelId: string | null,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  // Flows limited to other numbers (Starter, several numbers) sit out.
  const typed = (flows as FlowRow[]).filter((f) => flowListensOn(f, channelId));
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "business_hours") {
    return isWithinBusinessHours(new Date(), {
      window: cfg.value,
      days: cfg.days,
      timezone: cfg.timezone,
    });
  }
  if (cfg.subject === "var") {
    const raw = readPath(run.vars, cfg.subject_key);
    const v = raw !== null && typeof raw === "object" ? JSON.stringify(raw) : raw;
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  // `{{vars.order.status}}` reads into an object saved by a webhook node.
  return template.replace(/\{\{vars\.([a-zA-Z0-9_.]+)\}\}/g, (_, key: string) =>
    varToText(readPath(vars, key)),
  );
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "create_deal") {
      const cfg = node.config as unknown as CreateDealNodeConfig;
      try {
        if (!cfg.pipeline_id || !cfg.stage_id) {
          throw new Error("create_deal needs a pipeline and a stage");
        }
        // Same currency rule as the automations create_deal step: the
        // account's default, USD for pre-021 rows.
        const { data: acct } = await db
          .from("accounts")
          .select("default_currency")
          .eq("id", run.account_id)
          .maybeSingle();
        const { data: deal, error } = await db
          .from("deals")
          .insert({
            account_id: run.account_id,
            user_id: run.user_id,
            pipeline_id: cfg.pipeline_id,
            stage_id: cfg.stage_id,
            contact_id: run.contact_id,
            title:
              interpolateVars(cfg.title ?? "", run.vars).trim() || "Flow",
            value: Number(cfg.value) || 0,
            currency:
              (acct as { default_currency?: string } | null)
                ?.default_currency ?? "USD",
            status: "open",
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "create_deal",
          deal_id: (deal as { id: string }).id,
        });
      } catch (err) {
        // Non-fatal, like set_tag: the customer keeps going.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "create_deal_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "wait") {
      const cfg = node.config as unknown as WaitNodeConfig;
      const resumeAt = new Date(Date.now() + waitDurationMs(cfg.amount, cfg.unit));
      let q = db
        .from("flow_runs")
        .update({
          current_node_key: node.node_key,
          resume_at: resumeAt.toISOString(),
          last_advanced_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .eq("status", "active");
      q = run.current_node_key === null
        ? q.is("current_node_key", null)
        : q.eq("current_node_key", run.current_node_key);
      const { data: parked } = await q.select("id");
      if (!parked || parked.length === 0) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        run.current_node_key = node.node_key;
        run.resume_at = resumeAt.toISOString();
        await logEvent(db, run.id, "node_entered", node.node_key, {
          waiting_until: resumeAt.toISOString(),
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "http_fetch") {
      const cfg = node.config as unknown as HttpFetchNodeConfig;
      const ok = await executeHttpFetch(db, run, node.node_key, cfg);
      currentKey = ok || !cfg.error_next ? cfg.next_node_key : cfg.error_next;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "go_to_flow") {
      return goToFlow(db, run, node);
    }
    if (node.node_type === "end") {
      const endCfg = (node.config ?? {}) as EndNodeConfig;
      if (endCfg.close_conversation && run.conversation_id) {
        await db
          .from("conversations")
          .update({ status: "closed", updated_at: new Date().toISOString() })
          .eq("id", run.conversation_id)
          .eq("account_id", run.account_id);
      }
      await logEvent(db, run.id, "completed", node.node_key, {
        closed_conversation: Boolean(endCfg.close_conversation),
      });
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/** How many flows one conversation may chain through in a row. */
export const MAX_FLOW_HOPS = 5;
const HOPS_VAR = "_flow_hops";

/** Why a jump to `target` is refused, or null when it may go ahead. */
export function goToFlowRefusal(
  target: Pick<FlowRow, "id" | "account_id" | "status" | "entry_node_id"> | null,
  run: Pick<FlowRunRow, "flow_id" | "account_id">,
  hops: number,
): string | null {
  if (!target || target.account_id !== run.account_id) return "go_to_flow_not_found";
  if (target.id === run.flow_id) return "go_to_flow_same_flow";
  if (target.status !== "active" || !target.entry_node_id) return "go_to_flow_inactive";
  if (hops >= MAX_FLOW_HOPS) return "go_to_flow_loop";
  return null;
}

/**
 * The "Ir para outro fluxo" block: this run ends, and a new run of the
 * target flow starts at its entry node with the same vars. The target
 * must be another active flow of the same account. A chain longer than
 * MAX_FLOW_HOPS (a loop between flows) fails instead of going on.
 */
async function goToFlow(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  const cfg = (node.config ?? {}) as Partial<GoToFlowNodeConfig>;
  const hops = Number((run.vars ?? {})[HOPS_VAR]) || 0;
  const target = cfg.flow_id ? await loadFlow(db, cfg.flow_id) : null;
  const reason = goToFlowRefusal(target, run, hops);
  if (reason || !target) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason,
      flow_id: cfg.flow_id ?? null,
    });
    await endRun(db, run.id, "failed", reason ?? "go_to_flow_not_found");
    return { outcome: "completed" };
  }

  await logEvent(db, run.id, "completed", node.node_key, { go_to_flow: target.id });
  await endRun(db, run.id, "completed", "go_to_flow");

  const vars = { ...(run.vars ?? {}), [HOPS_VAR]: hops + 1 };
  const { data: inserted, error } = await db
    .from("flow_runs")
    .insert({
      flow_id: target.id,
      account_id: target.account_id,
      user_id: target.user_id,
      contact_id: run.contact_id,
      conversation_id: run.conversation_id,
      status: "active",
      current_node_key: target.entry_node_id,
      vars,
    })
    .select("*")
    .maybeSingle();
  if (error || !inserted) {
    console.error("[flows] go_to_flow insert error:", error?.message ?? "no row");
    return { outcome: "completed" };
  }
  const next = inserted as FlowRunRow;
  await logEvent(db, next.id, "started", target.entry_node_id, {
    flow_id: target.id,
    trigger_type: "go_to_flow",
    from_flow_id: run.flow_id,
    from_run_id: run.id,
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: target.id,
  });
  if (incErr) console.error("[flows] execution_count rpc error:", incErr.message);

  const nodes = await loadAllNodes(db, target.id);
  return advanceFromNodeKey(db, next, target.entry_node_id!, nodes);
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      input.channelId ?? null,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

/**
 * http_fetch: call the configured URL and keep the answer in
 * `vars[save_as]`. Same SSRF guard as the automations webhook step: no
 * private / loopback addresses, no redirects, 10 s timeout. Returns
 * whether the call succeeded (2xx).
 */
async function executeHttpFetch(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
  cfg: HttpFetchNodeConfig,
): Promise<boolean> {
  try {
    const { data: contact } = run.contact_id
      ? await db
          .from("contacts")
          .select("name, phone, email, company")
          .eq("id", run.contact_id)
          .maybeSingle()
      : { data: null };
    const scope = { vars: run.vars, contact: contact ?? {} };
    const fill = (tpl: string, json: boolean) =>
      tpl.replace(/\{\{(vars|contact)\.([a-zA-Z0-9_.]+)\}\}/g, (_, root: string, key: string) => {
        const text = varToText(readPath(scope[root as "vars" | "contact"], key));
        return json ? JSON.stringify(text).slice(1, -1) : encodeURIComponent(text);
      });

    const url = fill(cfg.url ?? "", false).trim();
    if (!url || !(await isDeliverableUrl(url))) {
      throw new Error("destination not allowed");
    }
    const method = cfg.method === "GET" ? "GET" : "POST";
    const headers: Record<string, string> = {
      accept: "application/json",
      ...parseHeaderLines(cfg.headers_text),
    };
    let body: string | undefined;
    if (method === "POST") {
      const tpl = cfg.body_template?.trim();
      body = tpl
        ? fill(tpl, true)
        : JSON.stringify({ contact: scope.contact, vars: run.vars });
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).slice(0, 16_000);
    let parsed: unknown = text.slice(0, 2_000);
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: keep the (trimmed) text.
    }
    if (cfg.save_as && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.save_as)) {
      const newVars = { ...run.vars, [cfg.save_as]: parsed };
      const { error } = await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
      if (!error) run.vars = newVars;
    }
    await logEvent(db, run.id, res.ok ? "node_entered" : "error", nodeKey, {
      node_type: "http_fetch",
      status: res.status,
      ...(res.ok ? {} : { reason: "http_fetch_status" }),
    });
    return res.ok;
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: "http_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * collect_input `save_to`: copy the captured answer into the contact's
 * record. Only name, email and company, same list as the automations
 * update_contact_field step. Failure is logged and never blocks the run.
 */
async function saveCapturedToContact(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
  field: "name" | "email" | "company",
  value: string,
): Promise<void> {
  if (field !== "name" && field !== "email" && field !== "company") return;
  const stored = field === "email" ? value.toLowerCase() : value;
  const { error } = await db
    .from("contacts")
    .update({ [field]: stored.slice(0, 255) })
    .eq("id", run.contact_id!)
    .eq("account_id", run.account_id);
  if (error) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: "save_to_contact_failed",
      field,
      detail: error.message,
    });
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // "sair" / "atendente" at any point: stop the bot, hand to a person.
  const policy = resolveFallbackPolicy((await loadFlow(db, run.flow_id))?.fallback_policy);
  if (message.kind === "text" && isExitMessage(message.text, policy)) {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, { reason: "exit_keyword" });
    await endRun(db, run.id, "handed_off", "exit_keyword");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }

  // Sitting on a wait node: the reply stays in the inbox for the team,
  // and the flow carries on when the wait is over. No reprompt.
  if (currentNode.node_type === "wait") {
    await logEvent(db, run.id, "reply_received", currentNode.node_key, {
      during_wait: true,
    });
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    const valid = isValidCollectedInput(captured, cfg.validation, cfg.regex);
    if (!valid && captured.length > 0) {
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        validation_failed: cfg.validation ?? "any",
      });
    }
    if (valid && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        if (cfg.save_to && run.contact_id) {
          await saveCapturedToContact(db, run, currentNode.node_key, cfg.save_to, captured);
        }
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy (loaded above).
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "collect_input") {
        // Customer typed something we couldn't accept (empty, or not in
        // the node's format). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

// ============================================================
// Manual start (inbox "Iniciar fluxo")
// ============================================================

export type ManualStartResult =
  | { ok: true; flow_run_id: string; outcome: string }
  | {
      ok: false;
      reason: "flow_not_found" | "flow_inactive" | "already_in_flow" | "start_failed";
    };

/**
 * Starts `flowId` for the contact of a conversation, on an agent's
 * request. The caller has already checked that the agent may act on
 * the conversation and that both belong to `accountId`. Any active
 * flow can be started this way, whatever its trigger. One active run
 * per contact still holds: a contact already in a flow is refused.
 */
export async function startFlowManually(args: {
  accountId: string;
  flowId: string;
  conversationId: string;
  contactId: string;
}): Promise<ManualStartResult> {
  const db = supabaseAdmin();
  const flow = await loadFlow(db, args.flowId);
  if (!flow || flow.account_id !== args.accountId) {
    return { ok: false, reason: "flow_not_found" };
  }
  if (flow.status !== "active" || !flow.entry_node_id) {
    return { ok: false, reason: "flow_inactive" };
  }
  const { data: existing } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", args.accountId)
    .eq("contact_id", args.contactId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: false, reason: "already_in_flow" };

  const { data: inserted, error } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (error || !inserted) {
    const msg = error?.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { ok: false, reason: "already_in_flow" };
    }
    console.error("[flows] startFlowManually insert error:", msg);
    return { ok: false, reason: "start_failed" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: "manual",
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) console.error("[flows] execution_count rpc error:", incErr.message);

  const nodes = await loadAllNodes(db, flow.id);
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id, nodes);
  return { ok: true, flow_run_id: run.id, outcome: outcome.outcome };
}

// ============================================================
// Wait resume (called by /api/flows/cron every 5 minutes)
// ============================================================

/**
 * Carries on every active run whose wait is over. The resume_at column
 * is cleared with an optimistic UPDATE first, so two overlapping cron
 * calls never resume the same run twice.
 */
export async function resumeWaitingRuns(limit = 50): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("status", "active")
    .not("resume_at", "is", null)
    .lte("resume_at", new Date().toISOString())
    .order("resume_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[flows] resume scan failed:", error.message);
    return 0;
  }
  let resumed = 0;
  for (const row of (data ?? []) as FlowRunRow[]) {
    const { data: claimed } = await db
      .from("flow_runs")
      .update({ resume_at: null })
      .eq("id", row.id)
      .eq("status", "active")
      .eq("resume_at", row.resume_at!)
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    try {
      const nodes = await loadAllNodes(db, row.flow_id);
      const node = row.current_node_key ? nodes.get(row.current_node_key) : undefined;
      if (!node || node.node_type !== "wait") continue;
      const next = (node.config as unknown as WaitNodeConfig).next_node_key;
      row.resume_at = null;
      await logEvent(db, row.id, "node_entered", node.node_key, { wait_over: true });
      await advanceFromNodeKey(db, row, next, nodes);
      resumed += 1;
    } catch (err) {
      console.error(
        "[flows] resume failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return resumed;
}
