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

import {
  DEFAULT_MEDIA_REPLY_TEXT,
  combineRules,
  isWithinBusinessHours,
  readCollectedReply,
  readPath,
  rulePredicate,
  varToText,
} from "./engine-match";
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
  | "route_taken"
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
  | { from: "customer"; text: string; media?: boolean }
  | { from: "system"; code: SimNoteCode; params?: Record<string, string | number> };

/** A question to the tester about something only the server knows. */
export interface SimChoice {
  code: "condition" | "webhook" | "router";
  params?: Record<string, string>;
  options: Array<{ code: "yes" | "no" | "success" | "error" | "route" | "else"; label?: string; next: string }>;
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
  | { kind: "media" }
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

/**
 * One rule's result in the browser: a var or the opening hours can be
 * known; a tag or a contact field cannot (null → ask the tester).
 */
function ruleResult(rule: Record<string, unknown>, vars: Record<string, unknown>, now: Date): boolean | null {
  if (rule.subject === "var") {
    const raw = readPath(vars, String(rule.subject_key ?? ""));
    const value = raw === undefined || raw === null ? undefined : varToText(raw);
    return rulePredicate(String(rule.operator ?? ""), value, typeof rule.value === "string" ? rule.value : undefined);
  }
  if (rule.subject === "business_hours") {
    return isWithinBusinessHours(now, {
      window: typeof rule.value === "string" ? rule.value : undefined,
      days: Array.isArray(rule.days) ? (rule.days as number[]) : undefined,
      timezone: typeof rule.timezone === "string" ? rule.timezone : undefined,
    });
  }
  return null;
}

/** All rules known → their combined result; any unknown → null. */
function rulesResult(
  rules: Array<Record<string, unknown>>,
  match: unknown,
  vars: Record<string, unknown>,
  now: Date,
): boolean | null {
  const results = rules.map((r) => ruleResult(r, vars, now));
  if (results.some((r) => r === null)) return null;
  return combineRules(results as boolean[], match === "any" ? "any" : "all");
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
        const extra = Array.isArray(cfg.extra_rules) ? (cfg.extra_rules as Array<Record<string, unknown>>) : [];
        const result = rulesResult([cfg, ...extra], cfg.match, s.vars, now);
        if (result === null) {
          // A tag or a contact field: only the tester knows.
          s.choice = {
            code: "condition",
            params: { subject: String((([cfg, ...extra].find((r) => ruleResult(r, s.vars, now) === null) ?? cfg).subject) ?? "") },
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
      case "router": {
        const routes = Array.isArray(cfg.routes)
          ? (cfg.routes as Array<{ id?: string; label?: string; match?: string; rules?: Array<Record<string, unknown>>; next_node_key?: string }>)
          : [];
        const elseNext = String(cfg.else_next ?? "");
        let picked: { next: string; label: string } | null = null;
        let unknown = false;
        for (const [i, route] of routes.entries()) {
          const r = rulesResult(route.rules ?? [], route.match, s.vars, now);
          if (r === null) {
            unknown = true;
            break;
          }
          if (r) {
            picked = { next: route.next_node_key ?? "", label: route.label?.trim() || String(i + 1) };
            break;
          }
        }
        if (unknown) {
          s.choice = {
            code: "router",
            options: [
              ...routes.map((route, i) => ({
                code: "route" as const,
                label: route.label?.trim() || String(i + 1),
                next: route.next_node_key ?? "",
              })),
              { code: "else" as const, next: elseNext },
            ],
          };
          s.currentKey = node.node_key;
          return s;
        }
        note("route_taken", { route: picked ? picked.label : "else" });
        current = picked ? picked.next : elseNext;
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
    transcript: [
      ...state.transcript,
      input.kind === "media"
        ? { from: "customer", text: "", media: true }
        : { from: "customer", text: input.kind === "text" ? input.text : input.title },
    ],
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
  let mediaWithoutText = false;
  if (input.kind === "tap" && (node.node_type === "send_buttons" || node.node_type === "send_list")) {
    matched = replyTarget(node, input.id);
  } else if (input.kind !== "tap" && node.node_type === "collect_input") {
    const cfg = node.config ?? {};
    const validation = cfg.validation as "any" | "email" | "phone" | "regex" | "media" | undefined;
    const read = readCollectedReply(
      input.kind === "media"
        ? { kind: "media", media_kind: "image", media_url: "https://exemplo/foto.jpg" }
        : { kind: "text", text: input.text },
      validation,
      typeof cfg.regex === "string" ? cfg.regex : undefined,
    );
    const text = read.captured;
    mediaWithoutText = read.mediaWithoutText;
    if (read.valid) {
      const varKey = typeof cfg.var_key === "string" ? cfg.var_key : "";
      if (varKey) s.vars[varKey] = text;
      if (input.kind === "text" && typeof cfg.save_to === "string" && cfg.save_to) {
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
  // Reprompt: the same node sends its question again, after asking for
  // a written answer when a photo / audio came without text.
  const hint = mediaWithoutText
    ? interp(
        (typeof node.config?.media_reply_text === "string" && node.config.media_reply_text.trim()) ||
          DEFAULT_MEDIA_REPLY_TEXT,
        s.vars,
      )
    : null;
  return advance(
    {
      ...s,
      reprompts,
      transcript: [
        ...s.transcript,
        ...(hint ? [{ from: "bot" as const, kind: "text" as const, text: hint }] : []),
        { from: "system" as const, code: "reprompt" as const },
      ],
    },
    byKey,
    node.node_key,
    now,
  );
}
