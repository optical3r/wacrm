// ============================================================
// GET /api/v1/flows/{id}/runs — the latest runs of a flow, newest
// first (flows:read). ?status= filter, ?limit= up to 100.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { parseListParams } from '@/lib/api/v1/pagination';
import { RUN_COLUMNS, RUN_STATUSES } from '@/lib/api/v1/flows';

export const GET = apiRoute<{ id: string }>('flows:read', async (ctx, request, { id }) => {
  if (!isUuid(id) || !(await ctx.db.owns('flows', id))) return fail('not_found', 'Flow not found', 404);
  const { limit } = parseListParams(request);
  const status = new URL(request.url).searchParams.get('status');
  let query = ctx.db.from('flow_runs').select(RUN_COLUMNS).eq('flow_id', id);
  if (status !== null) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`'status' deve ser um de: ${RUN_STATUSES.join(', ')}`);
    }
    query = query.eq('status', status);
  }
  const { data, error } = await query.order('started_at', { ascending: false }).limit(limit);
  if (error) return fail('internal', 'Failed to list runs', 500);
  return okList(data ?? [], null);
});
