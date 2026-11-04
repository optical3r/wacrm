import { describe, it, expect } from "vitest";
import { chooseInSimulation, replyInSimulation, startSimulation, type SimNode } from "./simulate";

const nodes: SimNode[] = [
  { node_key: "start", node_type: "start", config: { next_node_key: "hello" } },
  { node_key: "hello", node_type: "send_message", config: { text: "Olá!", next_node_key: "menu" } },
  {
    node_key: "menu",
    node_type: "send_buttons",
    config: {
      text: "Escolha",
      buttons: [
        { reply_id: "b1", title: "Comprar", next_node_key: "ask" },
        { reply_id: "b2", title: "Falar", next_node_key: "human" },
      ],
    },
  },
  {
    node_key: "ask",
    node_type: "collect_input",
    config: { prompt_text: "Seu e-mail?", var_key: "email", validation: "email", next_node_key: "tagged" },
  },
  { node_key: "tagged", node_type: "condition", config: { subject: "tag", subject_key: "t1", operator: "present", true_next: "bye", false_next: "wait" } },
  { node_key: "wait", node_type: "wait", config: { amount: 10, unit: "minutes", next_node_key: "bye" } },
  { node_key: "bye", node_type: "send_message", config: { text: "Obrigado, {{vars.email}}", next_node_key: "end" } },
  { node_key: "human", node_type: "handoff", config: {} },
  { node_key: "end", node_type: "end", config: {} },
];
const policy = { on_unknown_reply: "reprompt", max_reprompts: 1, on_exhaust: "handoff", exit_keywords: ["sair"] };

describe("flow simulator", () => {
  it("plays messages until the first question", () => {
    const s = startSimulation("start", nodes);
    expect(s.transcript.map((b) => (b.from === "bot" ? b.kind : b.from))).toEqual(["text", "buttons"]);
    expect(s.currentKey).toBe("menu");
    expect(s.ended).toBe(false);
  });

  it("follows a tap, validates the answer, asks the tester and fills vars", () => {
    let s = startSimulation("start", nodes);
    s = replyInSimulation(s, nodes, policy, { kind: "tap", id: "b1", title: "Comprar" });
    expect(s.currentKey).toBe("ask");
    s = replyInSimulation(s, nodes, policy, { kind: "text", text: "não sei" });
    expect(s.transcript.some((b) => b.from === "system" && b.code === "invalid_format")).toBe(true);
    expect(s.currentKey).toBe("ask");
    s = replyInSimulation(s, nodes, policy, { kind: "text", text: "a@b.com" });
    expect(s.vars.email).toBe("a@b.com");
    expect(s.choice?.code).toBe("condition");
    s = chooseInSimulation(s, nodes, s.choice!.options[1].next);
    const last = s.transcript.filter((b) => b.from === "bot").at(-1);
    expect(last).toEqual({ from: "bot", kind: "text", text: "Obrigado, a@b.com" });
    expect(s.transcript.some((b) => b.from === "system" && b.code === "wait_skipped")).toBe(true);
    expect(s.ended).toBe(true);
  });

  it("applies the fallback policy and the exit words", () => {
    let s = startSimulation("start", nodes);
    s = replyInSimulation(s, nodes, policy, { kind: "text", text: "oi?" });
    expect(s.transcript.some((b) => b.from === "system" && b.code === "reprompt")).toBe(true);
    s = replyInSimulation(s, nodes, policy, { kind: "text", text: "de novo" });
    expect(s.ended).toBe(true);
    expect(s.transcript.at(-1)).toEqual({ from: "system", code: "handoff_unknown" });

    let t = startSimulation("start", nodes);
    t = replyInSimulation(t, nodes, policy, { kind: "text", text: "Sair!" });
    expect(t.transcript.at(-1)).toEqual({ from: "system", code: "exit_keyword" });
  });

  it("stops on a missing node or an endless loop", () => {
    expect(startSimulation("nope", nodes).transcript.at(-1)).toMatchObject({ code: "node_missing" });
    const loop: SimNode[] = [
      { node_key: "a", node_type: "set_tag", config: { mode: "add", next_node_key: "b" } },
      { node_key: "b", node_type: "set_tag", config: { mode: "add", next_node_key: "a" } },
    ];
    expect(startSimulation("a", loop).transcript.at(-1)).toEqual({ from: "system", code: "loop" });
  });
});
