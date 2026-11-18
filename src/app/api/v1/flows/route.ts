// ============================================================
// GET /api/v1/flows — list the account's flows (flows:read).
//   ?status=draft|active|archived
// Building or editing a flow stays in the visual editor.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail, badRequest } from '@/lib/api/v1/respond';
import { FLOW_COLUMNS, serializeFlow } from '@/lib/api/v1/flows';
import { FLOW_STATUSES } from '@/lib/flows/status-core';

export const GET = apiRoute('flows:read', async (ctx, request) => {
  const status = new URL(request.url).searchParams.get('status');
  let query = ctx.db.from('flows').select(FLOW_COLUMNS);
  if (status !== null) {
    if (!(FLOW_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`'status' deve ser um de: ${FLOW_STATUSES.join(', ')}`);
    }
    query = query.eq('status', status);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return fail('internal', 'Failed to list flows', 500);
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeFlow), null);
});
