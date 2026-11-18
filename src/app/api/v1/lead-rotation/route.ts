// ============================================================
// GET /api/v1/lead-rotation — the "Rodízio de leads" setting (team:read):
// whether new leads are handed out in turn, to whom, and who got the
// last one.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';

export const GET = apiRoute('team:read', async (ctx) => {
  const { data, error } = await ctx.db
    .from('lead_rotation')
    .select('enabled, member_ids, last_user_id, updated_at')
    .maybeSingle();
  if (error) return fail('internal', 'Failed to read lead rotation', 500);
  return ok({
    enabled: Boolean(data?.enabled),
    member_ids: (data?.member_ids as string[] | null) ?? [],
    last_user_id: (data?.last_user_id as string | null) ?? null,
    updated_at: (data?.updated_at as string | null) ?? null,
  });
});
