// ============================================================
// GET /api/v1/flows/{id} — a flow with its nodes (flows:read).
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { FLOW_COLUMNS, serializeFlow } from '@/lib/api/v1/flows';

export const GET = apiRoute<{ id: string }>('flows:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Flow not found', 404);
  const { data } = await ctx.db.from('flows').select(FLOW_COLUMNS).eq('id', id).maybeSingle();
  if (!data) return fail('not_found', 'Flow not found', 404);
  const nodes = await ctx.db.child('flow_nodes', id, 'Flow');
  const { data: rows } = await nodes.select('node_key, node_type, config');
  return ok({
    ...serializeFlow(data as Record<string, unknown>),
    nodes: ((rows ?? []) as Record<string, unknown>[]).map((n) => ({
      key: n.node_key,
      type: n.node_type,
      config: n.config ?? {},
    })),
  });
});
