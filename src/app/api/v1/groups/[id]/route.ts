// ============================================================
// PATCH /api/v1/groups/{id} — { "hidden": true|false } hides a group
// from the inbox (its new messages stop being saved) or shows it
// again (conversations:write). Plano Starter only.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';

export const PATCH = apiRoute<{ id: string }>('conversations:write', async (ctx, request, { id }) => {
  requirePlan(ctx, 'starter', 'Grupos');
  if (!isUuid(id)) return fail('not_found', 'Group not found', 404);
  const body = await readJsonObject(request);
  if (typeof body.hidden !== 'boolean') throw badRequest("'hidden' deve ser true ou false");
  const { data: conv } = await ctx.db
    .from('conversations')
    .select('id, contact_id')
    .eq('id', id)
    .eq('is_group', true)
    .maybeSingle();
  if (!conv) return fail('not_found', 'Group not found', 404);
  const hiddenAt = body.hidden ? new Date().toISOString() : null;
  const { data, error } = await ctx.db
    .from('contacts')
    .update({ group_hidden_at: hiddenAt })
    .eq('id', conv.contact_id)
    .eq('is_group', true)
    .select('id')
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update group', 500);
  if (!data) return fail('not_found', 'Group not found', 404);
  return ok({ id, hidden_at: hiddenAt });
});
