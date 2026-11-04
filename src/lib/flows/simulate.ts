/**
 * Flow simulator: plays a flow in the editor, as the customer would see
 * it, without sending anything on WhatsApp or writing to the database.
 *
 * Pure and browser-safe (no engine / Supabase imports). It follows the
 * runner's rules where they can be known in the browser: interpolation,
 * button / list taps, collect_input validation, exit words and the
 * fallback policy. What the browser cannot know (a contact's tags or
 * fields, a webhook's answer) is asked to the tester as a choice.
 * Side effects (tags, deals, waits, handoff) become notes.
 */

import { isValidCollectedInput, isWithinBusinessHours, readPath, varToText } from "./engine-match";
import { decideFallback, isExitMessage, resolveFallbackPolicy } from "./fallback";

export interface SimNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export type SimNoteCode =
  | "tag_added"
  | "tag_removed"
  | "deal_created"
  | "wait_skipped"
  | "webhook_skipped"
  | "saved_to_contact"
  | "condition_result"
  | "invalid_format"
  | "reprompt"
  | "ignored"
  | "exit_keyword"
  | "handoff"
  | "handoff_unknown"
  | "go_to_flow"
  | "end"
  | "end_unknown"
  | "node_missing"
  | "loop";

export type SimBubble =
  | { from: "bot"; kind: "text"; text: string }
  | { from: "bot"; kind: "media"; mediaType: string; url: string; caption?: string }
  | {
      from: "bot";
      kind: "buttons" | "list";
      text: string;
      header?: string;
      footer?: string;
      buttonLabel?: string;
      options: Array<{ id: string; title: string; description?: string }>;
    }
  | { from: "customer"; text: string }
  | { from: "system"; code: SimNoteCode; params?: Record<string, string | number> };

/** A question to the tester about something only the server knows. */
export interface SimChoice {
  code: "condition" | "webhook";
  params?: Record<string, string>;
  options: Array<{ code: "yes" | "no" | "success" | "error"; next: string }>;
}

export interface SimState {
  /** Node that waits for a reply or a choice. */
  currentKey: string | null;
  choice: SimChoice | null;
  vars: Record<string, unknown>;
  reprompts: number;
  ended: boolean;
  transcript: SimBubble[];
}

export type SimInput =
  | { kind: "text"; text: string }
  | { kind: "tap"; id: string; title: string };

const MAX_STEPS = 64;

function interp(template: unknown, vars: Record<string, unknown>): string {
  const s = typeof template === "string" ? template : "";
  return s.replace(/\{\{vars\.([a-zA-Z0-9_.]+)\}\}/g, (_, key: string) => varToText(readPath(vars, key)));
}

function optional(template: unknown, vars: Record<string, unknown>): string | undefined {
  return typeof template === "string" && template !== "" ? interp(template, vars) : undefined;
}

function nextOf(cfg: Record<string, unknown>): string {
  return typeof cfg.next_node_key === "string" ? cfg.next_node_key : "";
}

function conditionHolds(operator: unknown, subject: string | undefined, value: string | undefined): boolean {
  switch (operator) {
    case "present":
      return subject !== undefined && subject !== "";
    case "absent":
      return subject === undefined || subject === "";
    case "equals":
      return subject !== undefined && subject === (value ?? "");
    case "contains":
      return subject !== undefined && subject.includes(value ?? "");
    default:
      return false;
  }
}

function replyTarget(node: SimNode, replyId: string): string | null {
  const cfg = node.config;
  if (node.node_type === "send_buttons") {
    const buttons = (cfg.buttons ?? []) as Array<{ reply_id?: string; next_node_key?: string }>;
    return buttons.find((b) => b.reply_id === replyId)?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const sections = (cfg.sections ?? []) as Array<{ rows?: Array<{ reply_id?: string; next_node_key?: string }> }>;
    for (const s of sections) {
      const hit = (s.rows ?? []).find((r) => r.reply_id === replyId);
      if (hit) return hit.next_node_key ?? null;
    }
  }
  return null;
}

/**
 * Walk from `key` through the nodes that need no reply, until one waits
 * (reply or choice) or the flow ends. Returns a new state.
 */
function advance(prev: SimState, nodes: Map<string, SimNode>, key: string, now: Date): SimState {
  const s: SimState = { ...prev, transcript: [...prev.transcript], vars: { ...prev.vars }, choice: null };
  let current: string | null = key;
  const note = (code: SimNoteCode, params?: Record<string, string | number>) =>
    s.transcript.push({ from: "system", code, ...(params ? { params } : {}) });
  const finish = (code: SimNoteCode, params?: Record<string, string | number>) => {
    note(code, params);
    s.ended = true;
    s.currentKey = null;
    return s;
  };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const node: SimNode | undefined = current ? nodes.get(current) : undefined;
    if (!node) return finish("node_missing", { key: current ?? "" });
    const cfg: Record<string, unknown> = node.config ?? {};
    switch (node.node_type) {
      case "start":
        current = nextOf(cfg);
        continue;
      case "send_message":
        s.transcript.push({ from: "bot", kind: "text", text: interp(cfg.text, s.vars) });
        current = nextOf(cfg);
        continue;
      case "send_media":
        s.transcript.push({
          from: "bot",
          kind: "media",
          mediaType: String(cfg.media_type ?? "image"),
          url: String(cfg.media_url ?? ""),
          caption: optional(cfg.caption, s.vars),
        });
        current = nextOf(cfg);
        continue;
      case "collect_input":
        s.transcript.push({ from: "bot", kind: "text", text: interp(cfg.prompt_text, s.vars) });
        s.currentKey = node.node_key;
        return s;
      case "send_buttons": {
        const buttons = (cfg.buttons ?? []) as Array<{ reply_id?: string; title?: string }>;
        s.transcript.push({
          from: "bot",
          kind: "buttons",
          text: interp(cfg.text, s.vars),
          header: optional(cfg.header_text, s.vars),
          footer: optional(cfg.footer_text, s.vars),
          options: buttons.map((b) => ({ id: b.reply_id ?? "", title: interp(b.title, s.vars) })),
        });
        s.currentKey = node.node_key;
        return s;
      }
      case "send_list": {
        const sections = (cfg.sections ?? []) as Array<{
          rows?: Array<{ reply_id?: string; title?: string; description?: string }>;
        }>;
        s.transcript.push({
          from: "bot",
          kind: "list",
          text: interp(cfg.text, s.vars),
          header: optional(cfg.header_text, s.vars),
          footer: optional(cfg.footer_text, s.vars),
          buttonLabel: interp(cfg.button_label, s.vars),
          options: sections.flatMap((sec) =>
            (sec.rows ?? []).map((r) => ({
              id: r.reply_id ?? "",
              title: interp(r.title, s.vars),
              description: optional(r.description, s.vars),
            })),
          ),
        });
        s.currentKey = node.node_key;
        return s;
      }
      case "condition": {
        const trueNext: string = String(cfg.true_next ?? "");
        const falseNext = String(cfg.false_next ?? "");
        let result: boolean | null = null;
        if (cfg.subject === "var") {
          const raw = readPath(s.vars, String(cfg.subject_key ?? ""));
          const value = raw === undefined || raw === null ? undefined : varToText(raw);
          result = conditionHolds(cfg.operator, value, typeof cfg.value === "string" ? cfg.value : undefined);
        } else if (cfg.subject === "business_hours") {
          result = isWithinBusinessHours(now, {
            window: typeof cfg.value === "string" ? cfg.value : undefined,
            days: Array.isArray(cfg.days) ? (cfg.days as number[]) : undefined,
            timezone: typeof cfg.timezone === "string" ? cfg.timezone : undefined,
          });
        }
        if (result === null) {
          // A tag or a contact field: only the tester knows.
          s.choice = {
            code: "condition",
            params: { subject: String(cfg.subject ?? ""), key: String(cfg.subject_key ?? "") },
            options: [
              { code: "yes", next: trueNext },
              { code: "no", next: falseNext },
            ],
          };
          s.currentKey = node.node_key;
          return s;
        }
        note("condition_result", { result: result ? "yes" : "no", subject: String(cfg.subject ?? "") });
        current = result ? trueNext : falseNext;
        continue;
      }
      case "set_tag":
        note(cfg.mode === "remove" ? "tag_removed" : "tag_added");
        current = nextOf(cfg);
        continue;
      case "create_deal":
        note("deal_created", { title: interp(cfg.title, s.vars) });
        current = nextOf(cfg);
        continue;
      case "wait":
        note("wait_skipped", { amount: Number(cfg.amount) || 0, unit: String(cfg.unit ?? "minutes") });
        current = nextOf(cfg);
        continue;
      case "http_fetch": {
        const errorNext = typeof cfg.error_next === "string" ? cfg.error_next : "";
        if (errorNext) {
          s.choice = {
            code: "webhook",
            params: { url: String(cfg.url ?? "") },
            options: [
              { code: "success", next: nextOf(cfg) },
              { code: "error", next: errorNext },
            ],
          };
          s.currentKey = node.node_key;
          return s;
        }
        note("webhook_skipped", { url: String(cfg.url ?? "") });
        current = nextOf(cfg);
        continue;
      }
      case "handoff":
        return finish("handoff");
      case "go_to_flow":
        return finish("go_to_flow", { flow_id: String(cfg.flow_id ?? "") });
      case "end":
        return finish("end");
      default:
        return finish("node_missing", { key: node.node_key });
    }
  }
  return finish("loop");
}

/** Start the flow at its entry node. */
export function startSimulation(
  entryKey: string | null,
  nodes: SimNode[],
  now: Date = new Date(),
): SimState {
  const empty: SimState = { currentKey: null, choice: null, vars: {}, reprompts: 0, ended: false, transcript: [] };
  return advance(empty, new Map(nodes.map((n) => [n.node_key, n])), entryKey ?? "", now);
}

/** The tester answered a choice (condition / webhook outcome). */
export function chooseInSimulation(
  state: SimState,
  nodes: SimNode[],
  next: string,
  now: Date = new Date(),
): SimState {
  if (state.ended || !state.choice) return state;
  return advance({ ...state, choice: null }, new Map(nodes.map((n) => [n.node_key, n])), next, now);
}

/** The "customer" typed a message or tapped an option. */
export function replyInSimulation(
  state: SimState,
  nodes: SimNode[],
  fallbackPolicy: unknown,
  input: SimInput,
  now: Date = new Date(),
): SimState {
  if (state.ended || state.choice) return state;
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const policy = resolveFallbackPolicy(fallbackPolicy);
  const s: SimState = {
    ...state,
    vars: { ...state.vars },
    transcript: [...state.transcript, { from: "customer", text: input.kind === "text" ? input.text : input.title }],
  };
  const end = (code: SimNoteCode): SimState => ({
    ...s,
    ended: true,
    currentKey: null,
    transcript: [...s.transcript, { from: "system", code }],
  });

  if (input.kind === "text" && isExitMessage(input.text, policy)) return end("exit_keyword");

  const node = s.currentKey ? byKey.get(s.currentKey) : undefined;
  if (!node) return end("node_missing");

  let matched: string | null = null;
  if (input.kind === "tap" && (node.node_type === "send_buttons" || node.node_type === "send_list")) {
    matched = replyTarget(node, input.id);
  } else if (input.kind === "text" && node.node_type === "collect_input") {
    const cfg = node.config ?? {};
    const text = input.text.trim();
    const validation = cfg.validation as "any" | "email" | "phone" | "regex" | undefined;
    if (isValidCollectedInput(text, validation, typeof cfg.regex === "string" ? cfg.regex : undefined)) {
      const varKey = typeof cfg.var_key === "string" ? cfg.var_key : "";
      if (varKey) s.vars[varKey] = text;
      if (typeof cfg.save_to === "string" && cfg.save_to) {
        s.transcript.push({ from: "system", code: "saved_to_contact", params: { field: cfg.save_to } });
      }
      matched = nextOf(cfg);
    } else if (text) {
      s.transcript.push({ from: "system", code: "invalid_format", params: { validation: validation ?? "any" } });
    }
  }

  if (matched) return advance({ ...s, reprompts: 0 }, byKey, matched, now);

  const reprompts = s.reprompts + 1;
  const action = decideFallback({ policy, reprompt_count: reprompts });
  if (action.type === "ignore") {
    return { ...s, transcript: [...s.transcript, { from: "system", code: "ignored" }] };
  }
  if (action.type === "handoff") return end("handoff_unknown");
  if (action.type === "end") return end("end_unknown");
  // Reprompt: the same node sends its question again.
  return advance(
    { ...s, reprompts, transcript: [...s.transcript, { from: "system", code: "reprompt" }] },
    byKey,
    node.node_key,
    now,
  );
}
