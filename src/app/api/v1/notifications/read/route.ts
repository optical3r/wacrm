// ============================================================
// POST /api/v1/notifications/read — mark the key creator's
// notifications as read (notifications:write).
//   { "ids": ["…"] }  only these;  {} every unread one.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, stringArray } from '@/lib/api/v1/body';

export const POST = apiRoute('notifications:write', async (ctx, request) => {
  if (!ctx.createdBy) return ok({ marked: 0 });
  const body = await readJsonObject(request);
  const ids = stringArray(body, 'ids', 500);
  if (ids && ids.some((i) => !isUuid(i))) throw badRequest("'ids' deve ter só IDs");
  let query = ctx.db
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', ctx.createdBy)
    .is('read_at', null);
  if (ids) query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const { data, error } = await query.select('id');
  if (error) return fail('internal', 'Failed to mark notifications', 500);
  return ok({ marked: (data ?? []).length });
});
