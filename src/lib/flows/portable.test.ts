import { describe, expect, it } from "vitest";
import {
  buildFlowExport,
  clearForeignRefs,
  collectRefs,
  copyName,
  emptyRefs,
  MAX_IMPORT_NODES,
  parseFlowImport,
} from "./portable";

const flow = {
  name: "Menu",
  description: "Atendimento",
  trigger_type: "keyword",
  trigger_config: { keywords: ["oi"], channel_ids: ["ch1", "ch2"] },
  entry_node_id: "start",
  fallback_policy: { mode: "handoff" },
};
const nodes = [
  { node_key: "start", node_type: "start", config: { next: "tag" }, position_x: 10.4, position_y: 20 },
  { node_key: "tag", node_type: "set_tag", config: { tag_id: "t1", next: "deal" } },
  { node_key: "deal", node_type: "create_deal", config: { pipeline_id: "p1", stage_id: "s1", next: "cond" } },
  {
    node_key: "cond",
    node_type: "condition",
    config: {
      subject: "tag",
      subject_key: "t2",
      operator: "has",
      extra_rules: [{ subject: "tag", subject_key: "t3", operator: "has" }],
    },
  },
  {
    node_key: "route",
    node_type: "router",
    config: { routes: [{ id: "r1", rules: [{ subject: "tag", subject_key: "t4" }] }], else_next: "hand" },
  },
  { node_key: "hand", node_type: "handoff", config: { assign_to: "u1" } },
  { node_key: "go", node_type: "go_to_flow", config: { flow_id: "f1" } },
];

describe("flow export/import", () => {
  it("exports design only and round-trips through import", () => {
    const out = buildFlowExport(flow, nodes, new Date("2026-11-04T00:00:00Z"));
    expect(out.format).toBe("labcrm-flow");
    expect(out.exported_at).toBe("2026-11-04T00:00:00.000Z");
    expect(out.nodes[0].position_x).toBe(10);
    expect(out.nodes[1].position_x).toBe(0);
    expect(Object.keys(out.flow)).not.toContain("status");
    const back = parseFlowImport(JSON.parse(JSON.stringify(out)));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.data.nodes).toHaveLength(nodes.length);
      expect(back.data.flow.entry_node_id).toBe("start");
      expect(back.data.flow.fallback_policy).toEqual({ mode: "handoff" });
    }
  });

  it("refuses files that are not flows", () => {
    expect(parseFlowImport(null)).toEqual({ ok: false, error: "not_a_flow" });
    expect(parseFlowImport({ format: "x", flow: {}, nodes: [] })).toEqual({ ok: false, error: "not_a_flow" });
    const base = buildFlowExport(flow, nodes);
    expect(parseFlowImport({ ...base, version: 99 })).toEqual({ ok: false, error: "unsupported_version" });
    expect(parseFlowImport({ ...base, flow: { ...base.flow, trigger_type: "cron" } })).toEqual({
      ok: false,
      error: "bad_trigger",
    });
    expect(parseFlowImport({ ...base, nodes: [{ node_key: "a b", node_type: "start" }] })).toEqual({
      ok: false,
      error: "bad_node",
    });
    expect(parseFlowImport({ ...base, nodes: [{ node_key: "a", node_type: "evil" }] })).toEqual({
      ok: false,
      error: "bad_node",
    });
    expect(
      parseFlowImport({ ...base, nodes: [{ node_key: "a", node_type: "end" }, { node_key: "a", node_type: "end" }] }),
    ).toEqual({ ok: false, error: "duplicate_node" });
    const many = Array.from({ length: MAX_IMPORT_NODES + 1 }, (_, i) => ({ node_key: `n${i}`, node_type: "end" }));
    expect(parseFlowImport({ ...base, nodes: many })).toEqual({ ok: false, error: "too_many_nodes" });
  });

  it("drops an entry node that is not in the file and defaults the name", () => {
    const base = buildFlowExport(flow, nodes);
    const res = parseFlowImport({ ...base, flow: { ...base.flow, name: "  ", entry_node_id: "nope" } });
    expect(res.ok && res.data.flow.entry_node_id).toBeNull();
    expect(res.ok && res.data.flow.name).toBe("Fluxo importado");
  });

  it("collects every account-scoped id", () => {
    const refs = collectRefs(buildFlowExport(flow, nodes));
    expect([...refs.tags].sort()).toEqual(["t1", "t2", "t3", "t4"]);
    expect([...refs.pipelines]).toEqual(["p1"]);
    expect([...refs.stages]).toEqual(["s1"]);
    expect([...refs.users]).toEqual(["u1"]);
    expect([...refs.flows]).toEqual(["f1"]);
    expect([...refs.channels]).toEqual(["ch1", "ch2"]);
  });

  it("keeps ids the account has and clears the rest", () => {
    const data = buildFlowExport(flow, nodes);
    const all = collectRefs(data);
    expect(clearForeignRefs(data, all).cleared).toBe(0);

    const known = emptyRefs();
    known.tags.add("t2");
    known.channels.add("ch1");
    known.stages.add("s1"); // stage known but its pipeline isn't
    const { data: out, cleared } = clearForeignRefs(data, known);
    // ch2, t1, p1, s1, t3, t4, u1, f1
    expect(cleared).toBe(8);
    expect(out.flow.trigger_config.channel_ids).toEqual(["ch1"]);
    const byKey = Object.fromEntries(out.nodes.map((n) => [n.node_key, n.config]));
    expect(byKey.tag.tag_id).toBe("");
    expect(byKey.tag.next).toBe("deal");
    expect(byKey.deal.pipeline_id).toBe("");
    expect(byKey.deal.stage_id).toBe("");
    expect(byKey.cond.subject_key).toBe("t2");
    expect((byKey.cond.extra_rules as Array<{ subject_key: string }>)[0].subject_key).toBe("");
    const routes = byKey.route.routes as Array<{ rules: Array<{ subject_key: string }> }>;
    expect(routes[0].rules[0].subject_key).toBe("");
    expect(byKey.hand.assign_to).toBe("");
    expect(byKey.go.flow_id).toBe("");
    // the input is not mutated
    expect(data.nodes[1].config.tag_id).toBe("t1");
  });

  it("names a copy", () => {
    expect(copyName("Menu", "(cópia)")).toBe("Menu (cópia)");
    expect(copyName("x".repeat(130), "(cópia)")).toHaveLength(120);
  });
});
