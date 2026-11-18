// ============================================================
// POST /api/v1/broadcasts/{id}/cancel — stop a broadcast that is still
// going out (broadcasts:send). Recipients not yet sent are marked
// failed ("Cancelado antes do envio"); messages already sent stay
// sent. A finished broadcast answers 400. Plano Pro only.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { BROADCAST_COLUMNS, CANCELLED_MESSAGE } from '@/lib/api/v1/broadcasts';

export const POST = apiRoute<{ id: string }>('broadcasts:send', async (ctx, _request, { id }) => {
  requirePlan(ctx, 'pro', 'Disparos');
  if (!isUuid(id)) return fail('not_found', 'Broadcast not found', 404);
  const { data: b } = await ctx.db.from('broadcasts').select('id, status').eq('id', id).maybeSingle();
  if (!b) return fail('not_found', 'Broadcast not found', 404);
  if (b.status !== 'sending' && b.status !== 'scheduled' && b.status !== 'draft') {
    throw badRequest('Este disparo já terminou');
  }

  const recipients = await ctx.db.child('broadcast_recipients', id, 'Broadcast');
  const { data: stopped, error } = await recipients
    .update({ status: 'failed', error_message: CANCELLED_MESSAGE })
    .eq('status', 'pending')
    .select('id');
  if (error) return fail('internal', 'Failed to cancel broadcast', 500);

  // Same rule as the delivery loop's finish: all failed → failed.
  const { count: total } = await recipients.select('id', { count: 'exact', head: true });
  const { count: failed } = await recipients
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed');
  const { data } = await ctx.db
    .from('broadcasts')
    .update({
      status: (failed ?? 0) === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(BROADCAST_COLUMNS)
    .maybeSingle();
  return ok({ ...(data ?? { id }), cancelled_recipients: (stopped ?? []).length });
});
