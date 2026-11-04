import { describe, it, expect } from "vitest";
import { isValidCollectedInput } from "./engine-match";
import { buildFunnel } from "./funnel";
import { validateFlowForActivation } from "./validate";
import { isAutoAdvancing } from "./engine";
import { deriveCanvasEdges } from "./edges";

describe("isValidCollectedInput", () => {
  it("accepts any non-empty text by default", () => {
    expect(isValidCollectedInput("oi", undefined)).toBe(true);
    expect(isValidCollectedInput("oi", "any")).toBe(true);
    expect(isValidCollectedInput("   ", "any")).toBe(false);
  });
  it("checks email", () => {
    expect(isValidCollectedInput("ana@exemplo.com.br", "email")).toBe(true);
    expect(isValidCollectedInput(" ana@exemplo.com ", "email")).toBe(true);
    expect(isValidCollectedInput("ana@exemplo", "email")).toBe(false);
    expect(isValidCollectedInput("meu email é ana@x.com", "email")).toBe(false);
  });
  it("checks phone", () => {
    expect(isValidCollectedInput("(71) 99999-8888", "phone")).toBe(true);
    expect(isValidCollectedInput("+55 71 99999-8888", "phone")).toBe(true);
    expect(isValidCollectedInput("99999-8888", "phone")).toBe(false);
    expect(isValidCollectedInput("liga 71999998888", "phone")).toBe(false);
  });
  it("checks a custom regex and ignores a broken one", () => {
    expect(isValidCollectedInput("40000-000", "regex", "^\\d{5}-?\\d{3}$")).toBe(true);
    expect(isValidCollectedInput("400", "regex", "^\\d{5}-?\\d{3}$")).toBe(false);
    expect(isValidCollectedInput("qualquer", "regex", "([")).toBe(true);
  });
});

describe("buildFunnel", () => {
  const nodes = [
    { node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
    { node_key: "ask", node_type: "collect_input", config: { next_node_key: "deal" } },
    { node_key: "deal", node_type: "create_deal", config: { next_node_key: "bye" } },
    { node_key: "bye", node_type: "end", config: {} },
    { node_key: "orphan", node_type: "send_message", config: { next_node_key: "" } },
  ];
  it("orders steps from the entry and keeps unreachable ones last", () => {
    const steps = buildFunnel(nodes, "start", { start: 10, ask: 7, deal: 4 });
    expect(steps.map((s) => s.node_key)).toEqual(["start", "ask", "deal", "bye", "orphan"]);
    expect(steps.map((s) => s.runs)).toEqual([10, 7, 4, 0, 0]);
  });
});

describe("create_deal node", () => {
  const flow = {
    name: "Lead",
    trigger_type: "manual" as const,
    trigger_config: {},
    entry_node_id: "s",
  };
  it("auto-advances", () => {
    expect(isAutoAdvancing("create_deal")).toBe(true);
  });
  it("needs a stage and a title", () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: "s", node_type: "start", config: { next_node_key: "d" } },
      { node_key: "d", node_type: "create_deal", config: { next_node_key: "e" } },
      { node_key: "e", node_type: "end", config: {} },
    ]);
    expect(issues.some((i) => i.node_key === "d" && i.field === "stage_id")).toBe(true);
    expect(issues.some((i) => i.node_key === "d" && i.field === "title")).toBe(true);
  });
  it("passes when complete, and draws its edge", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "d" } },
      {
        node_key: "d",
        node_type: "create_deal",
        config: { pipeline_id: "p", stage_id: "st", title: "Lead", next_node_key: "e" },
      },
      { node_key: "e", node_type: "end", config: {} },
    ];
    expect(validateFlowForActivation(flow, nodes).filter((i) => i.severity === "error")).toEqual([]);
    expect(deriveCanvasEdges(nodes as never).some((e) => e.source === "d" && e.target === "e")).toBe(true);
  });
  it("flags an invalid regex on collect_input", () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: "s", node_type: "start", config: { next_node_key: "c" } },
      {
        node_key: "c",
        node_type: "collect_input",
        config: { prompt_text: "CEP?", var_key: "cep", validation: "regex", regex: "([", next_node_key: "e" },
      },
      { node_key: "e", node_type: "end", config: {} },
    ]);
    expect(issues.some((i) => i.node_key === "c" && i.field === "regex")).toBe(true);
  });
});
