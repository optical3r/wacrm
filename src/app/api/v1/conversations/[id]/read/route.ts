// ============================================================
// POST /api/v1/conversations/{id}/read — mark a conversation as read
// (scope: conversations:write): zeroes the CRM's unread count and, as
// when an attendant opens the chat, marks the customer's messages as
// read on WhatsApp (blue ticks). The WhatsApp part is best effort.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { markConversationReadOnWhatsApp } from '@/lib/whatsapp/mark-read';

export const POST = apiRoute<{ id: string }>('conversations:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);
  const { data, error } = await ctx.db
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) return fail('internal', 'Failed to mark as read', 500);
  if (!data) return fail('not_found', 'Conversation not found', 404);

  let markedOnWhatsApp = 0;
  try {
    // Vetted core: filters by accountId itself.
    markedOnWhatsApp = await markConversationReadOnWhatsApp(ctx.db.trusted, ctx.accountId, id);
  } catch (err) {
    console.warn('[api/v1/conversations] WhatsApp read failed:', err);
  }
  return ok({ id, unread_count: 0, marked_on_whatsapp: markedOnWhatsApp });
});
