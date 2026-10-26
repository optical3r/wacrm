"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Plan = "starter" | "pro";
type Status = "pending" | "active" | "blocked";

interface AdminAccount {
  id: string;
  name: string;
  plan: Plan;
  status: Status;
  created_at: string;
  owner_email: string | null;
  owner_name: string | null;
  members: number;
  conversations_30d: number;
  messages_30d: number;
  last_message_at: string | null;
  whatsapp: { status: string; connected_at: string | null } | null;
}

type Action =
  | { action: "approve"; plan: Plan }
  | { action: "reject" }
  | { action: "block" }
  | { action: "unblock" }
  | { action: "set_plan"; plan: Plan }
  | { action: "disconnect_whatsapp" };

// Actions that cut access or a connection ask first.
const CONFIRM: Partial<Record<Action["action"], true>> = {
  reject: true,
  block: true,
  set_plan: true,
  disconnect_whatsapp: true,
};

const STATUS_FILTERS = ["all", "pending", "active", "blocked"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR");
}

/**
 * Platform owner's panel: every organization on LabCRM, signup
 * approval, plans (Starter = QR code, Pro = official API) and blocking.
 * The API refuses anyone outside SUPER_ADMIN_EMAILS.
 */
export default function AdminPage() {
  const t = useTranslations("Admin");
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [planFilter, setPlanFilter] = useState<"all" | Plan>("all");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ account: AdminAccount; action: Action } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/accounts", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAccounts(data.accounts);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (account: AdminAccount, action: Action) => {
      setBusyId(account.id);
      try {
        const res = await fetch(`/api/admin/accounts/${account.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast.success(t(`done.${action.action}`, { name: account.name }));
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("saveFailed"));
      } finally {
        setBusyId(null);
      }
    },
    [load, t],
  );

  const ask = (account: AdminAccount, action: Action) => {
    if (CONFIRM[action.action]) setPending({ account, action });
    else run(account, action);
  };

  const totals = useMemo(() => {
    const list = accounts ?? [];
    return {
      pending: list.filter((a) => a.status === "pending").length,
      active: list.filter((a) => a.status === "active").length,
      blocked: list.filter((a) => a.status === "blocked").length,
      starter: list.filter((a) => a.status === "active" && a.plan === "starter").length,
      pro: list.filter((a) => a.status === "active" && a.plan === "pro").length,
      connected: list.filter((a) => a.whatsapp?.status === "connected").length,
    };
  }, [accounts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? [])
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter((a) => planFilter === "all" || a.plan === planFilter)
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          (a.owner_email ?? "").toLowerCase().includes(q),
      )
      // Pending first: they are waiting on you.
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  }, [accounts, statusFilter, planFilter, query]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ["pending", totals.pending],
            ["active", totals.active],
            ["blocked", totals.blocked],
            ["starter", totals.starter],
            ["pro", totals.pro],
            ["connected", totals.connected],
          ] as const
        ).map(([key, value]) => (
          <Card key={key} className={cn(key === "pending" && value > 0 && "border-primary/50")}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t(`totals.${key}`)}</p>
              <p className="font-heading text-2xl font-bold text-foreground">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => setStatusFilter(s)}
          >
            {t(`filters.${s}`)}
          </Button>
        ))}
        <span className="mx-1 h-6 w-px bg-border" />
        {(["all", "starter", "pro"] as const).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={planFilter === p ? "default" : "outline"}
            onClick={() => setPlanFilter(p)}
          >
            {p === "all" ? t("filters.allPlans") : t(`plan.${p}`)}
          </Button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="pl-8"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading && !accounts ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("cols.organization")}</TableHead>
                  <TableHead>{t("cols.status")}</TableHead>
                  <TableHead>{t("cols.plan")}</TableHead>
                  <TableHead>{t("cols.whatsapp")}</TableHead>
                  <TableHead className="text-right">{t("cols.team")}</TableHead>
                  <TableHead className="text-right">{t("cols.usage")}</TableHead>
                  <TableHead>{t("cols.dates")}</TableHead>
                  <TableHead className="text-right">{t("cols.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((a) => {
                  const busy = busyId === a.id;
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <p className="font-medium text-foreground">{a.name}</p>
                        <p className="text-xs text-muted-foreground">{a.owner_email ?? "—"}</p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            a.status === "active"
                              ? "secondary"
                              : a.status === "pending"
                                ? "default"
                                : "destructive"
                          }
                        >
                          {t(`status.${a.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{t(`plan.${a.plan}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.whatsapp
                          ? t(`whatsapp.${a.whatsapp.status === "connected" ? "connected" : "disconnected"}`)
                          : t("whatsapp.none")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{a.members}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {t("usage", { conversations: a.conversations_30d, messages: a.messages_30d })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <p>{t("createdAt", { date: formatDate(a.created_at) })}</p>
                        <p>{t("lastActivity", { date: formatDate(a.last_message_at) })}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {busy && <Loader2 className="h-4 w-4 animate-spin self-center" />}
                          {a.status === "pending" && (
                            <>
                              <Button size="sm" disabled={busy} onClick={() => ask(a, { action: "approve", plan: "starter" })}>
                                {t("actions.approveStarter")}
                              </Button>
                              <Button size="sm" disabled={busy} onClick={() => ask(a, { action: "approve", plan: "pro" })}>
                                {t("actions.approvePro")}
                              </Button>
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => ask(a, { action: "reject" })}>
                                {t("actions.reject")}
                              </Button>
                            </>
                          )}
                          {a.status === "active" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  ask(a, { action: "set_plan", plan: a.plan === "pro" ? "starter" : "pro" })
                                }
                              >
                                {a.plan === "pro" ? t("actions.toStarter") : t("actions.toPro")}
                              </Button>
                              {a.whatsapp?.status === "connected" && (
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => ask(a, { action: "disconnect_whatsapp" })}>
                                  {t("actions.disconnect")}
                                </Button>
                              )}
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => ask(a, { action: "block" })}>
                                {t("actions.block")}
                              </Button>
                            </>
                          )}
                          {a.status === "blocked" && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => ask(a, { action: "unblock" })}>
                              {t("actions.unblock")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>{t(`confirm.${pending.action.action}.title`, { name: pending.account.name })}</DialogTitle>
                <DialogDescription>{t(`confirm.${pending.action.action}.desc`)}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPending(null)}>
                  {t("cancel")}
                </Button>
                <Button
                  onClick={() => {
                    const { account, action } = pending;
                    setPending(null);
                    run(account, action);
                  }}
                >
                  {t("confirmButton")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
