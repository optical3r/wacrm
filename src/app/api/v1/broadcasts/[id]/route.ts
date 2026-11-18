// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:read; keys with broadcasts:send also pass).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent'; the delivered/read
// counts continue to climb as Meta delivery webhooks arrive.
// Account-scoped: a foreign id → 404. Plano Pro only.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { BROADCAST_COLUMNS } from '@/lib/api/v1/broadcasts';

export const GET = apiRoute<{ id: string }>('broadcasts:read', async (ctx, _request, { id }) => {
  requirePlan(ctx, 'pro', 'Disparos');
  if (!isUuid(id)) return fail('not_found', 'Broadcast not found', 404);
  const { data, error } = await ctx.db.from('broadcasts').select(BROADCAST_COLUMNS).eq('id', id).maybeSingle();
  if (error) {
    console.error('[api/v1/broadcasts] read error:', error);
    return fail('internal', 'Failed to read broadcast', 500);
  }
  if (!data) return fail('not_found', 'Broadcast not found', 404);
  return ok(data);
});
