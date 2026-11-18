// ============================================================
// GET /api/v1/notifications — notifications of the person who created
// the key, newest first (notifications:read).
//   ?unread=true  ?limit= up to 100
// A key whose creator left the workspace has no notifications.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';

const NOTIFICATION_COLUMNS =
  'id, type, title, body, conversation_id, contact_id, actor_user_id, read_at, created_at';

export const GET = apiRoute('notifications:read', async (ctx, request) => {
  if (!ctx.createdBy) return okList([], null);
  const { limit } = parseListParams(request);
  let query = ctx.db.from('notifications').select(NOTIFICATION_COLUMNS).eq('user_id', ctx.createdBy);
  if (new URL(request.url).searchParams.get('unread') === 'true') query = query.is('read_at', null);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) return fail('internal', 'Failed to list notifications', 500);
  return okList(data ?? [], null);
});
