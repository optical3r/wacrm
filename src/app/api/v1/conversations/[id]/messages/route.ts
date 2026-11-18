// ============================================================
// POST /api/v1/conversations/{id}/messages — send into an existing
// conversation, groups included on the Starter plan (messages:send).
// Same message body as POST /api/v1/messages, without `to`.
//
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { readSendBody } from '@/lib/api/v1/send-body';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import type { Message } from '@/types';

export const GET = apiRoute<{ id: string }>('messages:read', async (ctx, request, { id }) => {
    const { limit, cursor } = parseListParams(request);

    // `child` proves the conversation is this account's (404 otherwise)
    // and pins every query to it.
    const messages = await ctx.db.child('messages', id, 'Conversation');

    let query = messages
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
});

export const POST = apiRoute<{ id: string }>('messages:send', async (ctx, request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);
  const { data: conv } = await ctx.db.from('conversations').select('id, is_group').eq('id', id).maybeSingle();
  if (!conv) return fail('not_found', 'Conversation not found', 404);
  // Groups exist only on Starter; refuse them anywhere else anyway.
  if (conv.is_group && ctx.plan !== 'starter') {
    return fail('forbidden', 'Grupos são do plano Starter', 403);
  }
  const message = readSendBody(await readJsonObject(request));
  // Vetted core: takes accountId and scopes by it.
  const result = await sendMessageToConversation(ctx.db.trusted, ctx.accountId, {
    ...message,
    conversationId: id,
  });
  return ok(
    { message_id: result.messageId, whatsapp_message_id: result.whatsappMessageId, conversation_id: id },
    201
  );
});
