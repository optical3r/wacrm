// ============================================================
// GET /api/v1/team — the workspace's members and roles (team:read).
// Read-only: inviting or removing people stays in the dashboard.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail } from '@/lib/api/v1/respond';
import { listWorkspaceMembers } from '@/lib/auth/workspace-members';

export const GET = apiRoute('team:read', async (ctx) => {
  // Vetted core: reads account_memberships by accountId.
  const { members, error } = await listWorkspaceMembers(ctx.db.trusted, ctx.accountId);
  if (error) return fail('internal', 'Failed to list team', 500);
  return okList(
    members.map((m) => ({
      user_id: m.user_id,
      full_name: m.full_name,
      email: m.email,
      role: m.role,
      joined_at: m.joined_at,
    })),
    null
  );
});
