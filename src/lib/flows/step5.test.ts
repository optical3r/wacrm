import { describe, it, expect } from "vitest";
import { goToFlowRefusal, isTerminal, MAX_FLOW_HOPS } from "./engine";
import { outgoingEdges, validateFlowForActivation } from "./validate";
import { deriveCanvasEdges } from "./edges";

const run = { flow_id: "flow-a", account_id: "acc-1" };
const target = { id: "flow-b", account_id: "acc-1", status: "active" as const, entry_node_id: "start" as string | null };

describe("go_to_flow", () => {
  it("is terminal for the current flow and has no outgoing edges", () => {
    expect(isTerminal("go_to_flow")).toBe(true);
    expect(outgoingEdges({ node_key: "g", node_type: "go_to_flow", config: { flow_id: "flow-b" } })).toEqual([]);
    expect(
      deriveCanvasEdges([{ node_key: "g", node_type: "go_to_flow", config: { flow_id: "flow-b" } }]),
    ).toEqual([]);
  });

  it("jumps to another active flow of the same account", () => {
    expect(goToFlowRefusal(target, run, 0)).toBeNull();
  });

  it("refuses a missing, foreign, same, inactive or looping target", () => {
    expect(goToFlowRefusal(null, run, 0)).toBe("go_to_flow_not_found");
    expect(goToFlowRefusal({ ...target, account_id: "acc-2" }, run, 0)).toBe("go_to_flow_not_found");
    expect(goToFlowRefusal({ ...target, id: "flow-a" }, run, 0)).toBe("go_to_flow_same_flow");
    expect(goToFlowRefusal({ ...target, status: "draft" as const }, run, 0)).toBe("go_to_flow_inactive");
    expect(goToFlowRefusal({ ...target, entry_node_id: null }, run, 0)).toBe("go_to_flow_inactive");
    expect(goToFlowRefusal(target, run, MAX_FLOW_HOPS)).toBe("go_to_flow_loop");
  });

  it("needs a target flow to activate", () => {
    const flow = { name: "Menu", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "g" } },
      { node_key: "g", node_type: "go_to_flow", config: { flow_id: "" } },
    ];
    const issues = validateFlowForActivation(flow, nodes);
    expect(issues.some((i) => i.node_key === "g" && i.field === "flow_id")).toBe(true);
    nodes[1].config.flow_id = "flow-b";
    expect(validateFlowForActivation(flow, nodes).filter((i) => i.severity === "error")).toEqual([]);
  });
});
