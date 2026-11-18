// ============================================================
// GET /api/v1/automations/{id}/logs — the latest runs of an
// automation, newest first (automations:read). ?limit= up to 100.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { parseListParams } from '@/lib/api/v1/pagination';
import { AUTOMATION_LOG_COLUMNS } from '@/lib/api/v1/flows';

export const GET = apiRoute<{ id: string }>('automations:read', async (ctx, request, { id }) => {
  if (!isUuid(id) || !(await ctx.db.owns('automations', id))) {
    return fail('not_found', 'Automation not found', 404);
  }
  const { limit } = parseListParams(request);
  const { data, error } = await ctx.db
    .from('automation_logs')
    .select(AUTOMATION_LOG_COLUMNS)
    .eq('automation_id', id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return fail('internal', 'Failed to list automation logs', 500);
  return okList(data ?? [], null);
});
