import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountRole, type AccountRole } from "@/lib/auth/roles";

/**
 * Members of one workspace, with their role there.
 *
 * Since migration 061 a person can belong to several workspaces, and
 * profiles.account_id / account_role only describe the workspace they
 * have open right now. The roster comes from account_memberships, so a
 * teammate who switched to another workspace still shows up here.
 */
export interface WorkspaceMember {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
}

export async function listWorkspaceMembers(
  db: SupabaseClient,
  accountId: string,
  roles?: AccountRole[],
): Promise<{ members: WorkspaceMember[]; error: string | null }> {
  let q = db
    .from("account_memberships")
    .select("user_id, role, created_at")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });
  if (roles?.length) q = q.in("role", roles);
  const { data: rows, error } = await q;
  if (error) return { members: [], error: error.message };
  const list = (rows ?? []) as Array<{ user_id: string; role: string; created_at: string }>;
  if (list.length === 0) return { members: [], error: null };

  const { data: people, error: pErr } = await db
    .from("profiles")
    .select("user_id, full_name, email, avatar_url")
    .in(
      "user_id",
      list.map((r) => r.user_id),
    );
  if (pErr) return { members: [], error: pErr.message };
  const byId = new Map(
    ((people ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null; avatar_url: string | null }>).map(
      (p) => [p.user_id, p],
    ),
  );
  const members = list.flatMap((r) => {
    if (!isAccountRole(r.role)) return [];
    const p = byId.get(r.user_id);
    return [
      {
        user_id: r.user_id,
        full_name: p?.full_name ?? "",
        email: p?.email ?? null,
        avatar_url: p?.avatar_url ?? null,
        role: r.role,
        joined_at: r.created_at,
      },
    ];
  });
  return { members, error: null };
}

/** Whether a user belongs to a workspace (any role, or one of `roles`). */
export async function isWorkspaceMember(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  roles?: AccountRole[],
): Promise<boolean> {
  let q = db
    .from("account_memberships")
    .select("user_id")
    .eq("account_id", accountId)
    .eq("user_id", userId);
  if (roles?.length) q = q.in("role", roles);
  const { data } = await q.maybeSingle();
  return !!data;
}
