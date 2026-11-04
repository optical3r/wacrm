import { describe, it, expect } from "vitest";
import { readCollectedReply } from "./engine-match";
import { entryTriggerTexts } from "./engine";
import { replyInSimulation, startSimulation, type SimNode } from "./simulate";

describe("media answers to a question", () => {
  it("a media question keeps the file link and refuses typed text", () => {
    expect(
      readCollectedReply({ kind: "media", media_kind: "image", media_url: "https://x/f.jpg" }, "media"),
    ).toEqual({ captured: "https://x/f.jpg", valid: true, mediaWithoutText: false });
    expect(readCollectedReply({ kind: "media", media_kind: "audio", media_url: null }, "media").captured).toBe("[audio]");
    expect(readCollectedReply({ kind: "text", text: "segue" }, "media").valid).toBe(false);
  });

  it("a text question takes the caption, and flags media with no text", () => {
    expect(
      readCollectedReply({ kind: "media", media_kind: "image", caption: " a@b.com " }, "email"),
    ).toEqual({ captured: "a@b.com", valid: true, mediaWithoutText: false });
    expect(readCollectedReply({ kind: "media", media_kind: "audio", caption: null }, "any")).toEqual({
      captured: "",
      valid: false,
      mediaWithoutText: true,
    });
  });

  it("media offers only its caption to entry triggers", () => {
    const base = { kind: "media" as const, media_kind: "image", media_url: null, meta_message_id: "m" };
    expect(entryTriggerTexts({ ...base, caption: "oi" })).toEqual(["oi"]);
    expect(entryTriggerTexts({ ...base, caption: null })).toEqual([]);
  });

  it("the simulator asks for a written answer, then repeats the question", () => {
    const nodes: SimNode[] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Seu nome?", var_key: "nome", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    let s = startSimulation("start", nodes);
    s = replyInSimulation(s, nodes, null, { kind: "media" });
    const bots = s.transcript.filter((b) => b.from === "bot").map((b) => (b.from === "bot" && b.kind === "text" ? b.text : ""));
    expect(bots).toEqual(["Seu nome?", "Por favor, responda por escrito.", "Seu nome?"]);
  });
});

import { combineRules, parseLooseNumber, rulePredicate } from "./engine-match";
import { outgoingEdges } from "./validate";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import { chooseInSimulation } from "./simulate";
import { validateFlowForActivation } from "./validate";

describe("richer conditions", () => {
  it("compares numbers written the Brazilian way", () => {
    expect(parseLooseNumber("R$ 1.234,50")).toBe(1234.5);
    expect(parseLooseNumber("3.5")).toBe(3.5);
    expect(parseLooseNumber("abc")).toBeNull();
    expect(rulePredicate("gt", "150", "100")).toBe(true);
    expect(rulePredicate("lte", "100,00", "100")).toBe(true);
    expect(rulePredicate("lt", "dez", "100")).toBe(false);
  });
  it("combines rules with and / or", () => {
    expect(combineRules([true, false], "all")).toBe(false);
    expect(combineRules([true, false], "any")).toBe(true);
    expect(combineRules([], "any")).toBe(false);
  });
});

const router = {
  node_key: "r",
  node_type: "router" as const,
  config: {
    routes: [
      { id: "r1", label: "Grande", match: "all", rules: [{ subject: "var", subject_key: "valor", operator: "gte", value: "1000" }], next_node_key: "big" },
      { id: "r2", label: "Médio", match: "any", rules: [{ subject: "var", subject_key: "valor", operator: "gte", value: "100" }, { subject: "var", subject_key: "vip", operator: "present" }], next_node_key: "mid" },
    ],
    else_next: "small",
  },
};

describe("router node", () => {
  it("wires one handle per route plus else", () => {
    const nodes = [router, ...["big", "mid", "small"].map((k) => ({ node_key: k, node_type: "end" as const, config: {} }))];
    expect(outgoingSlots(router).map((s) => s.id)).toEqual(["route:r1", "route:r2", "else"]);
    expect(deriveCanvasEdges(nodes).map((e) => e.sourceHandle)).toEqual(["route:r1", "route:r2", "else"]);
    expect(outgoingEdges(router)).toEqual(["big", "mid", "small"]);
    expect((applyEdgeConnection(router, "route:r2", "big") as { routes: Array<{ next_node_key: string }> }).routes[1].next_node_key).toBe("big");
    const [unlinked] = unlinkNodeReferences([router], "small");
    expect((unlinked.config as { else_next: string }).else_next).toBe("");
  });

  it("validates routes and number values", () => {
    const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
    const base = [
      { node_key: "start", node_type: "start", config: { next_node_key: "r" } },
      ...["big", "mid", "small"].map((k) => ({ node_key: k, node_type: "end", config: {} })),
    ];
    expect(validateFlowForActivation(flow, [...base, router]).filter((i) => i.severity === "error")).toEqual([]);
    const bad = { ...router, config: { ...router.config, else_next: "", routes: [{ ...router.config.routes[0], rules: [{ subject: "var", subject_key: "valor", operator: "gt", value: "muito" }] }] } };
    const fields = validateFlowForActivation(flow, [...base, bad]).map((i) => i.field);
    expect(fields).toContain("routes.0.rules.0.value");
    expect(fields).toContain("else_next");
  });

  it("the simulator picks the first matching route", () => {
    const nodes: SimNode[] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Valor?", var_key: "valor", next_node_key: "r" } },
      router,
      { node_key: "big", node_type: "send_message", config: { text: "grande", next_node_key: "end" } },
      { node_key: "mid", node_type: "send_message", config: { text: "médio", next_node_key: "end" } },
      { node_key: "small", node_type: "send_message", config: { text: "pequeno", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const lastBot = (s: ReturnType<typeof startSimulation>) =>
      s.transcript.filter((b) => b.from === "bot").map((b) => (b.from === "bot" && b.kind === "text" ? b.text : "")).at(-1);
    const answer = (v: string) => replyInSimulation(startSimulation("start", nodes), nodes, null, { kind: "text", text: v });
    expect(lastBot(answer("R$ 1.500,00"))).toBe("grande");
    expect(lastBot(answer("150"))).toBe("médio");
    expect(lastBot(answer("10"))).toBe("pequeno");
  });

  it("asks the tester when a route needs a tag", () => {
    const tagRouter = { ...router, config: { routes: [{ id: "r1", label: "VIP", match: "all", rules: [{ subject: "tag", subject_key: "t", operator: "present" }], next_node_key: "end" }], else_next: "end" } };
    const nodes: SimNode[] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "r" } },
      tagRouter,
      { node_key: "end", node_type: "end", config: {} },
    ];
    const s = startSimulation("start", nodes);
    expect(s.choice?.code).toBe("router");
    expect(s.choice?.options.map((o) => o.label ?? o.code)).toEqual(["VIP", "else"]);
    expect(chooseInSimulation(s, nodes, "end").ended).toBe(true);
  });
});
