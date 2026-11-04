"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { sortChannels } from "@/lib/whatsapp/channel-pick";

export interface InboxChannel {
  id: string;
  label: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  /** Attendants linked to the number (migration 056). */
  member_ids: string[];
  /** Inbox messages through this number start with the attendant's name. */
  sign_messages: boolean;
  status: string;
  is_default: boolean;
  created_at: string | null;
  /** label, else the only linked attendant's name, else a generic name — never empty. */
  name: string;
}

/**
 * The account's WhatsApp numbers for the inbox (migration 051): what to
 * call each one ("via Ana") and which the composer can send through.
 * Several only on Starter accounts; Pro accounts get their one number.
 */
export function useChannels(fallbackName: string) {
  const { account } = useAuth();
  const accountId = account?.id ?? null;
  const [channels, setChannels] = useState<InboxChannel[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data: rows, error } = await supabase
        .from("whatsapp_config")
        .select("id, label, owner_user_id, status, is_default, created_at, sign_messages")
        .eq("account_id", accountId);
      const { data: memberRows } = await supabase
        .from("whatsapp_channel_members")
        .select("channel_id, user_id")
        .eq("account_id", accountId);
      const membersOf = new Map<string, string[]>();
      for (const m of (memberRows ?? []) as Array<{ channel_id: string; user_id: string }>) {
        membersOf.set(m.channel_id, [...(membersOf.get(m.channel_id) ?? []), m.user_id]);
      }
      if (cancelled) return;
      if (error) {
        console.error("[channels] load failed:", error.message);
        setLoaded(true);
        return;
      }
      const list = ((rows ?? []) as Omit<InboxChannel, "owner_name" | "name" | "member_ids">[]).map((c) => ({
        ...c,
        sign_messages: c.sign_messages === true,
        member_ids: membersOf.get(c.id) ?? [],
      }));
      const ownerIds = [...new Set(list.flatMap((c) => c.member_ids))];
      const names = new Map<string, string>();
      if (ownerIds.length) {
        const { data: people } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", ownerIds);
        for (const p of (people ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null }>) {
          names.set(p.user_id, p.full_name || p.email || "");
        }
      }
      if (cancelled) return;
      setChannels(
        sortChannels(
          list.map((c) => {
            const ownerName = c.member_ids.length === 1 ? names.get(c.member_ids[0]) || null : null;
            return { ...c, owner_name: ownerName, name: c.label || ownerName || fallbackName };
          }),
        ),
      );
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, fallbackName]);

  return { channels, loaded };
}
