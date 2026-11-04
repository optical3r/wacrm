import { describe, it, expect } from "vitest";
import {
  isWithinBusinessHours,
  parseHeaderLines,
  parseHoursWindow,
  readPath,
  waitDurationMs,
} from "./engine-match";
import { findTriggerConflicts, flowListensOn, validateFlowForActivation } from "./validate";
import { isAutoAdvancing, isSuspending } from "./engine";
import { applyEdgeConnection, deriveCanvasEdges, unlinkNodeReferences } from "./edges";

// 2026-11-04 is a Wednesday. 15:00 UTC = 12:00 in São Paulo.
const wedNoonSP = new Date("2026-11-04T15:00:00Z");
const wedNightSP = new Date("2026-11-05T01:00:00Z"); // 22:00 Wed in SP
const sunNoonSP = new Date("2026-11-08T15:00:00Z");

describe("business hours", () => {
  it("parses the window", () => {
    expect(parseHoursWindow("08:00-18:00")).toEqual({ from: 480, to: 1080 });
    expect(parseHoursWindow("8-18")).toBeNull();
  });
  it("is open at noon on a weekday, closed at night and on Sunday", () => {
    const cfg = { window: "08:00-18:00", days: [1, 2, 3, 4, 5] };
    expect(isWithinBusinessHours(wedNoonSP, cfg)).toBe(true);
    expect(isWithinBusinessHours(wedNightSP, cfg)).toBe(false);
    expect(isWithinBusinessHours(sunNoonSP, cfg)).toBe(false);
  });
  it("handles a window that crosses midnight", () => {
    const cfg = { window: "18:00-02:00", days: [3] };
    expect(isWithinBusinessHours(wedNightSP, cfg)).toBe(true);
    // 01:00 Thursday SP still belongs to Wednesday's shift.
    expect(isWithinBusinessHours(new Date("2026-11-05T04:00:00Z"), cfg)).toBe(true);
    expect(isWithinBusinessHours(wedNoonSP, cfg)).toBe(false);
  });
  it("falls back to São Paulo on a bad time zone", () => {
    expect(isWithinBusinessHours(wedNoonSP, { window: "08:00-18:00", timezone: "Nope/Zone" })).toBe(true);
  });
});

describe("helpers", () => {
  it("caps the wait at 30 days", () => {
    expect(waitDurationMs(30, "minutes")).toBe(1_800_000);
    expect(waitDurationMs(90, "days")).toBe(30 * 86_400_000);
  });
  it("parses header lines", () => {
    expect(parseHeaderLines("Authorization: Bearer x\nbad line\nX-Id: 1")).toEqual({
      Authorization: "Bearer x",
      "X-Id": "1",
    });
  });
  it("reads nested paths", () => {
    expect(readPath({ pedido: { status: "enviado" } }, "pedido.status")).toBe("enviado");
    expect(readPath({ pedido: null }, "pedido.status")).toBeUndefined();
  });
  it("classifies the new nodes", () => {
    expect(isSuspending("wait")).toBe(true);
    expect(isAutoAdvancing("http_fetch")).toBe(true);
  });
});

describe("webhook edges", () => {
  const nodes = [
    { node_key: "w", node_type: "http_fetch", config: { url: "https://x.com", next_node_key: "ok", error_next: "bad" } },
    { node_key: "ok", node_type: "end", config: {} },
    { node_key: "bad", node_type: "handoff", config: {} },
  ];
  it("draws both branches and rewires the error one", () => {
    const edges = deriveCanvasEdges(nodes as never);
    expect(edges.map((e) => e.sourceHandle).sort()).toEqual(["error", "next"]);
    expect(applyEdgeConnection(nodes[0] as never, "error", "ok")).toEqual({ error_next: "ok" });
    expect(unlinkNodeReferences(nodes as never, "bad")[0].config).toMatchObject({ error_next: "" });
  });
});

describe("validation", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "s" };
  it("requires an https URL and a sane wait", () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: "s", node_type: "start", config: { next_node_key: "w" } },
      { node_key: "w", node_type: "wait", config: { amount: 0, unit: "minutes", next_node_key: "h" } },
      { node_key: "h", node_type: "http_fetch", config: { url: "http://x", next_node_key: "e" } },
      { node_key: "e", node_type: "end", config: {} },
    ]);
    expect(issues.some((i) => i.node_key === "w" && i.field === "amount")).toBe(true);
    expect(issues.some((i) => i.node_key === "h" && i.field === "url")).toBe(true);
  });
  it("accepts a business-hours condition without a subject key", () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: "s", node_type: "start", config: { next_node_key: "c" } },
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "business_hours", operator: "present", value: "08:00-18:00", true_next: "e", false_next: "e" },
      },
      { node_key: "e", node_type: "end", config: {} },
    ]);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("flow per number", () => {
  it("listens on its numbers only", () => {
    expect(flowListensOn({ trigger_config: {} }, "a")).toBe(true);
    expect(flowListensOn({ trigger_config: { channel_ids: ["a"] } }, "a")).toBe(true);
    expect(flowListensOn({ trigger_config: { channel_ids: ["a"] } }, "b")).toBe(false);
  });
  it("same keyword on different numbers is not a conflict", () => {
    const mine = { name: "A", trigger_type: "keyword", trigger_config: { keywords: ["oi"], channel_ids: ["a"] } };
    const other = { name: "B", trigger_type: "keyword", trigger_config: { keywords: ["oi"], channel_ids: ["b"] } };
    expect(findTriggerConflicts(mine, [other])).toEqual([]);
    const all = { name: "C", trigger_type: "keyword", trigger_config: { keywords: ["oi"] } };
    expect(findTriggerConflicts(mine, [all]).length).toBe(1);
  });
});
