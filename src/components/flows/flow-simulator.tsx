"use client";

/**
 * "Testar" panel: plays the flow being edited as a WhatsApp chat, with
 * the current (unsaved) nodes, without sending anything. The tester
 * types as the customer, taps buttons and list rows, and answers the
 * questions only the server could (a contact's tags, a webhook result).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical, RotateCcw, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  chooseInSimulation,
  replyInSimulation,
  startSimulation,
  type SimBubble,
  type SimState,
} from "@/lib/flows/simulate";
import { useFlowEditor } from "./flow-editor-state";

export function FlowSimulatorButton() {
  const t = useTranslations("Flows.simulator");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <FlaskConical className="h-3.5 w-3.5" />
        {t("open")}
      </Button>
      {open && <FlowSimulator open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

function FlowSimulator({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("Flows.simulator");
  const { flow, state: editor } = useFlowEditor();
  const nodes = editor.nodes;
  const [sim, setSim] = useState<SimState>(() => startSimulation(editor.entry_node_id, nodes));
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sim.transcript.length]);

  const restart = () => {
    setSim(startSimulation(editor.entry_node_id, nodes));
    setText("");
  };
  const send = () => {
    const value = text.trim();
    if (!value) return;
    setSim((s) => replyInSimulation(s, nodes, flow.fallback_policy, { kind: "text", text: value }));
    setText("");
  };
  const tap = (id: string, title: string) =>
    setSim((s) => replyInSimulation(s, nodes, flow.fallback_policy, { kind: "tap", id, title }));
  const choose = (next: string) => setSim((s) => chooseInSimulation(s, nodes, next));

  // Only the last bot message's options can be tapped.
  const lastBot = sim.transcript.reduce((acc, b, i) => (b.from === "bot" ? i : acc), -1);
  const canReply = !sim.ended && !sim.choice;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="border-border bg-popover flex w-full flex-col gap-0 border-l p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/50 p-4">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription className="text-xs">{t("description")}</SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-muted/40 p-4">
          {sim.transcript.map((b, i) => (
            <Bubble key={i} bubble={b} active={canReply && i === lastBot} onTap={tap} />
          ))}
          {sim.choice && (
            <div className="rounded-lg border border-dashed border-primary/50 bg-card p-3 text-xs">
              <p className="mb-2 text-foreground">
                {sim.choice.code === "condition"
                  ? t("askCondition", { subject: t(`subject.${sim.choice.params?.subject ?? "var"}`) })
                  : t("askWebhook", { url: sim.choice.params?.url ?? "" })}
              </p>
              <div className="flex gap-2">
                {sim.choice.options.map((o) => (
                  <Button key={o.code} size="sm" variant="outline" onClick={() => choose(o.next)}>
                    {t(`choice.${o.code}`)}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/50 p-3">
          <Button variant="ghost" size="icon-sm" onClick={restart} title={t("restart")} aria-label={t("restart")}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                send();
              }
            }}
            disabled={!canReply}
            placeholder={sim.ended ? t("ended") : t("placeholder")}
            className="bg-muted text-sm"
          />
          <Button size="icon-sm" onClick={send} disabled={!canReply || !text.trim()} aria-label={t("send")}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Bubble({
  bubble,
  active,
  onTap,
}: {
  bubble: SimBubble;
  active: boolean;
  onTap: (id: string, title: string) => void;
}) {
  const t = useTranslations("Flows.simulator");
  if (bubble.from === "system") {
    const params = { ...(bubble.params ?? {}) } as Record<string, string | number>;
    if (bubble.code === "wait_skipped") params.unit = t(`unit.${String(params.unit)}`);
    if (bubble.code === "condition_result") params.result = t(`choice.${String(params.result)}`);
    if (bubble.code === "saved_to_contact") params.field = t(`field.${String(params.field)}`);
    return (
      <p className="mx-auto max-w-[90%] rounded-md bg-background/70 px-2 py-1 text-center text-[11px] text-muted-foreground">
        {t(`note.${bubble.code}`, params)}
      </p>
    );
  }
  if (bubble.from === "customer") {
    return (
      <div className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-lg rounded-tr-none bg-primary px-3 py-2 text-sm text-primary-foreground">
        {bubble.text}
      </div>
    );
  }
  return (
    <div className="max-w-[85%] space-y-1">
      <div className="whitespace-pre-wrap rounded-lg rounded-tl-none bg-card px-3 py-2 text-sm text-foreground shadow-sm">
        {bubble.kind === "media" ? (
          <>
            <span className="block text-xs font-medium text-muted-foreground">
              {t(`media.${bubble.mediaType}`)}
            </span>
            {bubble.caption}
          </>
        ) : (
          <>
            {"header" in bubble && bubble.header && <span className="block font-semibold">{bubble.header}</span>}
            {bubble.text}
            {"footer" in bubble && bubble.footer && (
              <span className="mt-1 block text-[11px] text-muted-foreground">{bubble.footer}</span>
            )}
          </>
        )}
      </div>
      {(bubble.kind === "buttons" || bubble.kind === "list") && (
        <div className="space-y-1">
          {bubble.kind === "list" && bubble.buttonLabel && (
            <span className="block text-[11px] text-muted-foreground">{bubble.buttonLabel}</span>
          )}
          {bubble.options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={!active}
              onClick={() => onTap(o.id, o.title)}
              className={cn(
                "block w-full rounded-lg bg-card px-3 py-1.5 text-left text-sm text-primary shadow-sm transition-colors",
                active ? "hover:bg-primary-soft" : "opacity-60",
              )}
            >
              {o.title}
              {o.description && <span className="block text-[11px] text-muted-foreground">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
