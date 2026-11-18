// ============================================================
// POST /api/v1/flow-runs/{id}/stop — stop an active flow run
// (flows:write). The run ends as paused_by_agent, the same state as
// when an attendant steps into the chat, so the contact can start a
// flow again.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { RUN_COLUMNS } from '@/lib/api/v1/flows';

export const POST = apiRoute<{ id: string }>('flows:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Flow run not found', 404);
  const { data: run } = await ctx.db.from('flow_runs').select('id, status').eq('id', id).maybeSingle();
  if (!run) return fail('not_found', 'Flow run not found', 404);
  if (run.status !== 'active') throw badRequest('Esta execução já terminou');
  const { data, error } = await ctx.db
    .from('flow_runs')
    .update({ status: 'paused_by_agent', ended_at: new Date().toISOString(), end_reason: 'stopped_via_api' })
    .eq('id', id)
    .eq('status', 'active')
    .select(RUN_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to stop flow run', 500);
  if (!data) throw badRequest('Esta execução já terminou');
  return ok(data);
});
