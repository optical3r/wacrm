"use client";

import { useState } from "react";
import { Loader2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ActiveFlow {
  id: string;
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual";
}

/**
 * "Iniciar fluxo" in the conversation header: lists the account's
 * active flows (manual ones first) and starts the picked one for this
 * contact. The list loads when the menu opens, so the header costs no
 * query until someone uses it.
 */
export function StartFlowButton({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.startFlow");
  const [flows, setFlows] = useState<ActiveFlow[] | null>(null);
  const [starting, setStarting] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("flows")
      .select("id, name, trigger_type")
      .eq("status", "active")
      .order("name");
    if (error) {
      toast.error(t("loadFailed"));
      setFlows([]);
      return;
    }
    const rows = (data ?? []) as ActiveFlow[];
    rows.sort(
      (a, b) =>
        Number(b.trigger_type === "manual") - Number(a.trigger_type === "manual"),
    );
    setFlows(rows);
  }

  async function start(flow: ActiveFlow) {
    setStarting(true);
    try {
      const res = await fetch(`/api/flows/${flow.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error || t("startFailed"));
        return;
      }
      toast.success(t("started", { name: flow.name }));
    } catch {
      toast.error(t("startFailed"));
    } finally {
      setStarting(false);
    }
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void load();
      }}
    >
      <DropdownMenuTrigger
        disabled={starting}
        aria-label={t("button")}
        title={t("button")}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        {starting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Workflow className="h-3.5 w-3.5" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-border bg-popover">
        <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
          {t("menuTitle")}
        </div>
        <DropdownMenuSeparator className="bg-border" />
        {flows === null ? (
          <DropdownMenuItem disabled className="text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            {t("loading")}
          </DropdownMenuItem>
        ) : flows.length === 0 ? (
          <DropdownMenuItem disabled className="text-sm text-muted-foreground">
            {t("noFlows")}
          </DropdownMenuItem>
        ) : (
          flows.map((f) => (
            <DropdownMenuItem
              key={f.id}
              onClick={() => void start(f)}
              className="flex flex-col items-start gap-0 text-sm text-popover-foreground"
            >
              <span className="w-full truncate">{f.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {t(`trigger_${f.trigger_type}`)}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
