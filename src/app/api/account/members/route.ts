// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers } from "@/lib/auth/roles";
import { listWorkspaceMembers } from "@/lib/auth/workspace-members";
import type { AccountMember } from "@/types";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Memberships, not profiles.account_id: a teammate who has another
    // workspace open is still a member of this one (migration 061).
    const { members: rows, error } = await listWorkspaceMembers(ctx.supabase, ctx.accountId);

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: t('account.members.loadFailed') },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = rows.map((row) => ({
      user_id: row.user_id,
      full_name: row.full_name,
      email: canSeeEmails ? row.email : null,
      avatar_url: row.avatar_url,
      role: row.role,
      joined_at: row.joined_at,
    }));

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
