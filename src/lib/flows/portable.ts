/**
 * Flow export / import ("Exportar" / "Importar" on the Flows page).
 *
 * The file carries the flow's design only: name, trigger, fallback
 * policy and nodes. Never runs, counters, account or author. On import,
 * ids that point at the source account's data (tags, pipeline stages,
 * attendants, numbers, other flows) are cleared unless the target
 * account has them, so a copy into another account can't reference
 * data it can't see; activation then asks for the missing picks.
 */

export const FLOW_EXPORT_FORMAT = "labcrm-flow";
export const FLOW_EXPORT_VERSION = 1;
export const MAX_IMPORT_NODES = 200;
export const MAX_IMPORT_BYTES = 512 * 1024;

const NODE_TYPES = new Set([
  "start",
  "send_message",
  "send_buttons",
  "send_list",
  "send_media",
  "collect_input",
  "condition",
  "router",
  "set_tag",
  "create_deal",
  "wait",
  "http_fetch",
  "go_to_flow",
  "handoff",
  "end",
]);
const TRIGGER_TYPES = new Set(["keyword", "first_inbound_message", "manual"]);
const NODE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export interface PortableNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

export interface PortableFlow {
  format: typeof FLOW_EXPORT_FORMAT;
  version: number;
  exported_at?: string;
  flow: {
    name: string;
    description: string | null;
    trigger_type: "keyword" | "first_inbound_message" | "manual";
    trigger_config: Record<string, unknown>;
    entry_node_id: string | null;
    fallback_policy: Record<string, unknown> | null;
  };
  nodes: PortableNode[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function buildFlowExport(
  flow: {
    name: string;
    description?: string | null;
    trigger_type: string;
    trigger_config?: Record<string, unknown> | null;
    entry_node_id?: string | null;
    fallback_policy?: unknown;
  },
  nodes: Array<{ node_key: string; node_type: string; config: unknown; position_x?: number | null; position_y?: number | null }>,
  now: Date = new Date(),
): PortableFlow {
  return {
    format: FLOW_EXPORT_FORMAT,
    version: FLOW_EXPORT_VERSION,
    exported_at: now.toISOString(),
    flow: {
      name: flow.name,
      description: flow.description ?? null,
      trigger_type: flow.trigger_type as PortableFlow["flow"]["trigger_type"],
      trigger_config: flow.trigger_config ?? {},
      entry_node_id: flow.entry_node_id ?? null,
      fallback_policy: isObj(flow.fallback_policy) ? flow.fallback_policy : null,
    },
    nodes: nodes.map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type,
      config: isObj(n.config) ? n.config : {},
      position_x: Math.round(Number(n.position_x) || 0),
      position_y: Math.round(Number(n.position_y) || 0),
    })),
  };
}

export type ImportError =
  | "not_a_flow"
  | "unsupported_version"
  | "too_many_nodes"
  | "bad_node"
  | "duplicate_node"
  | "bad_trigger";

/** Checks an uploaded file. Returns the cleaned flow or why it was refused. */
export function parseFlowImport(raw: unknown): { ok: true; data: PortableFlow } | { ok: false; error: ImportError } {
  if (!isObj(raw) || raw.format !== FLOW_EXPORT_FORMAT || !isObj(raw.flow) || !Array.isArray(raw.nodes)) {
    return { ok: false, error: "not_a_flow" };
  }
  if (typeof raw.version !== "number" || raw.version > FLOW_EXPORT_VERSION) {
    return { ok: false, error: "unsupported_version" };
  }
  if (raw.nodes.length > MAX_IMPORT_NODES) return { ok: false, error: "too_many_nodes" };
  const f = raw.flow;
  if (typeof f.trigger_type !== "string" || !TRIGGER_TYPES.has(f.trigger_type)) {
    return { ok: false, error: "bad_trigger" };
  }
  const seen = new Set<string>();
  const nodes: PortableNode[] = [];
  for (const n of raw.nodes) {
    if (
      !isObj(n) ||
      typeof n.node_key !== "string" ||
      !NODE_KEY.test(n.node_key) ||
      typeof n.node_type !== "string" ||
      !NODE_TYPES.has(n.node_type) ||
      (n.config !== undefined && !isObj(n.config))
    ) {
      return { ok: false, error: "bad_node" };
    }
    if (seen.has(n.node_key)) return { ok: false, error: "duplicate_node" };
    seen.add(n.node_key);
    nodes.push({
      node_key: n.node_key,
      node_type: n.node_type,
      config: (n.config as Record<string, unknown>) ?? {},
      position_x: Math.round(Number(n.position_x) || 0),
      position_y: Math.round(Number(n.position_y) || 0),
    });
  }
  const entry = typeof f.entry_node_id === "string" && seen.has(f.entry_node_id) ? f.entry_node_id : null;
  return {
    ok: true,
    data: {
      format: FLOW_EXPORT_FORMAT,
      version: FLOW_EXPORT_VERSION,
      flow: {
        name: (typeof f.name === "string" && f.name.trim() ? f.name.trim() : "Fluxo importado").slice(0, 120),
        description: typeof f.description === "string" ? f.description.slice(0, 1000) : null,
        trigger_type: f.trigger_type as PortableFlow["flow"]["trigger_type"],
        trigger_config: isObj(f.trigger_config) ? f.trigger_config : {},
        entry_node_id: entry,
        fallback_policy: isObj(f.fallback_policy) ? f.fallback_policy : null,
      },
      nodes,
    },
  };
}

/** Ids in a flow that point at an account's own data. */
export interface AccountRefs {
  tags: Set<string>;
  stages: Set<string>;
  pipelines: Set<string>;
  users: Set<string>;
  flows: Set<string>;
  channels: Set<string>;
}

export function emptyRefs(): AccountRefs {
  return { tags: new Set(), stages: new Set(), pipelines: new Set(), users: new Set(), flows: new Set(), channels: new Set() };
}

function ruleList(cfg: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (cfg.subject !== undefined) out.push(cfg);
  if (Array.isArray(cfg.extra_rules)) out.push(...(cfg.extra_rules.filter(isObj) as Array<Record<string, unknown>>));
  if (Array.isArray(cfg.routes)) {
    for (const r of cfg.routes) {
      if (isObj(r) && Array.isArray(r.rules)) out.push(...(r.rules.filter(isObj) as Array<Record<string, unknown>>));
    }
  }
  return out;
}

/** Every account-scoped id the flow mentions. */
export function collectRefs(data: PortableFlow): AccountRefs {
  const refs = emptyRefs();
  const add = (set: Set<string>, v: unknown) => {
    if (typeof v === "string" && v) set.add(v);
  };
  const ch = data.flow.trigger_config.channel_ids;
  if (Array.isArray(ch)) ch.forEach((v) => add(refs.channels, v));
  for (const n of data.nodes) {
    const c = n.config;
    if (n.node_type === "set_tag") add(refs.tags, c.tag_id);
    if (n.node_type === "create_deal") {
      add(refs.pipelines, c.pipeline_id);
      add(refs.stages, c.stage_id);
    }
    if (n.node_type === "handoff") add(refs.users, c.assign_to);
    if (n.node_type === "go_to_flow") add(refs.flows, c.flow_id);
    for (const rule of ruleList(c)) if (rule.subject === "tag") add(refs.tags, rule.subject_key);
  }
  return refs;
}

/**
 * The flow with every id the target account does not have cleared to
 * "" (or dropped, for trigger numbers). Returns how many were cleared.
 */
export function clearForeignRefs(data: PortableFlow, known: AccountRefs): { data: PortableFlow; cleared: number } {
  let cleared = 0;
  const keep = (set: Set<string>, v: unknown): unknown => {
    if (typeof v !== "string" || !v || set.has(v)) return v;
    cleared += 1;
    return "";
  };
  const trigger = { ...data.flow.trigger_config };
  if (Array.isArray(trigger.channel_ids)) {
    const before = trigger.channel_ids.length;
    trigger.channel_ids = trigger.channel_ids.filter((v) => typeof v === "string" && known.channels.has(v));
    cleared += before - (trigger.channel_ids as unknown[]).length;
  }
  const fixRule = (rule: Record<string, unknown>) =>
    rule.subject === "tag" ? { ...rule, subject_key: keep(known.tags, rule.subject_key) } : rule;
  const nodes = data.nodes.map((n) => {
    let c: Record<string, unknown> = { ...n.config };
    if (n.node_type === "set_tag") c.tag_id = keep(known.tags, c.tag_id);
    if (n.node_type === "create_deal") {
      const pipelineOk = typeof c.pipeline_id === "string" && known.pipelines.has(c.pipeline_id);
      c.pipeline_id = keep(known.pipelines, c.pipeline_id);
      // A stage only makes sense inside its pipeline.
      c.stage_id = pipelineOk ? keep(known.stages, c.stage_id) : keep(new Set(), c.stage_id);
    }
    if (n.node_type === "handoff") c.assign_to = keep(known.users, c.assign_to);
    if (n.node_type === "go_to_flow") c.flow_id = keep(known.flows, c.flow_id);
    if (n.node_type === "condition") {
      c = fixRule(c);
      if (Array.isArray(c.extra_rules)) c.extra_rules = c.extra_rules.map((r) => (isObj(r) ? fixRule(r) : r));
    }
    if (n.node_type === "router" && Array.isArray(c.routes)) {
      c.routes = c.routes.map((r) =>
        isObj(r) && Array.isArray(r.rules) ? { ...r, rules: r.rules.map((x) => (isObj(x) ? fixRule(x) : x)) } : r,
      );
    }
    return { ...n, config: c };
  });
  return { data: { ...data, flow: { ...data.flow, trigger_config: trigger }, nodes }, cleared };
}

/** "Menu" → "Menu (cópia)". */
export function copyName(name: string, suffix: string): string {
  return `${name} ${suffix}`.slice(0, 120);
}
