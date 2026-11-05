"use client";

/**
 * Workspace picker at the top of the sidebar (migration 061).
 *
 * A client (e.g. "Optical") can have several workspaces, each with its
 * own numbers, chats and team. Shown only to someone in more than one
 * workspace, or to the client's owner when the client may have more.
 * Switching reloads the app on the dashboard so nothing from the
 * previous workspace stays on screen.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  canCreateWorkspace,
  shouldShowSwitcher,
  type WorkspaceRow,
} from "@/lib/workspaces/workspaces";

export function WorkspaceSwitcher() {
  const t = useTranslations("Workspaces");
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await createClient().rpc("list_my_workspaces");
    // Before migration 061 the function doesn't exist: just hide.
    if (error) {
      setRows([]);
      return;
    }
    setRows((data ?? []) as WorkspaceRow[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!rows || !shouldShowSwitcher(rows)) return null;
  const active = rows.find((r) => r.is_active) ?? rows[0];
  const canCreate = canCreateWorkspace(rows);

  const goTo = async (accountId: string) => {
    if (accountId === active.account_id) return;
    setSwitching(accountId);
    const { error } = await createClient().rpc("switch_workspace", { p_account_id: accountId });
    if (error) {
      setSwitching(null);
      toast.error(error.message || t("switchError"));
      return;
    }
    window.location.assign("/dashboard");
  };

  const create = async () => {
    const value = name.trim();
    if (!value) return;
    setCreating(true);
    const { error } = await createClient().rpc("create_workspace", { p_name: value });
    if (error) {
      setCreating(false);
      toast.error(error.message || t("createError"));
      return;
    }
    toast.success(t("created", { name: value }));
    window.location.assign("/settings?tab=whatsapp");
  };

  // Group by client: someone invited into another client's workspace
  // sees both clients.
  const clients = new Map<string, { name: string; items: WorkspaceRow[] }>();
  for (const r of rows) {
    const key = r.organization_id ?? r.account_id;
    const entry = clients.get(key) ?? { name: r.organization_name ?? r.name, items: [] };
    entry.items.push(r);
    clients.set(key, entry);
  }

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus:bg-muted focus:outline-none data-popup-open:bg-muted"
            aria-label={t("open")}
          >
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-muted-foreground">
                {active.organization_name ?? t("workspace")}
              </span>
              <span className="block truncate text-sm font-medium text-foreground">{active.name}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="min-w-56 bg-popover text-popover-foreground ring-border"
          >
            {[...clients.entries()].map(([key, client], i) => (
              <DropdownMenuGroup key={key}>
                {i > 0 && <DropdownMenuSeparator className="bg-border" />}
                <DropdownMenuLabel>{client.name}</DropdownMenuLabel>
                {client.items.map((w) => (
                  <DropdownMenuItem
                    key={w.account_id}
                    onClick={() => goTo(w.account_id)}
                    disabled={!!switching}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  >
                    {switching === w.account_id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className={cn("size-4", w.is_active ? "opacity-100" : "opacity-0")} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {w.status !== "active" && (
                      <span className="text-[10px] text-muted-foreground">{t(`status.${w.status}`)}</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
            {active.is_organization_owner && (
              <>
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  onClick={() => (canCreate ? setCreateOpen(true) : toast.info(t("limitReached", { max: active.organization_max_workspaces })))}
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                >
                  <Plus className="size-4" />
                  {t("new")}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {t("count", { count: active.organization_workspaces, max: active.organization_max_workspaces })}
                  </span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={createOpen} onOpenChange={(v) => !creating && setCreateOpen(v)}>
        <DialogContent className="bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("newDescription", { client: active.organization_name ?? active.name })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={80}
            className="bg-muted"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("cancel")}
            </Button>
            <Button onClick={create} disabled={!name.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
