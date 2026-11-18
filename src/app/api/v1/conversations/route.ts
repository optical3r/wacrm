// ============================================================
// GET  /api/v1/conversations — list conversations (scope: conversations:read)
// POST /api/v1/conversations — start (or find) the conversation with a
//      phone number { "phone": "+5511…" | "11 99999-8888", "name"? }
//      (scope: conversations:write). Nothing is sent.
//
// List is keyset-paginated (newest first). Filters: `?status=` (open/
// pending/closed), `?contact_id=`, `?owner_id=` (a lead owner),
// `?unassigned=true`, `?channel_id=` (a connected number),
// `?unread=true`. WhatsApp groups are left out (they come with the
// groups area). Each conversation embeds its contact + tags.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { parseTypedPhone } from '@/lib/inbox/typed-phone';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export const GET = apiRoute('conversations:read', async (ctx, request) => {
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    const ownerId = url.searchParams.get('owner_id');
    const channelId = url.searchParams.get('channel_id');
    for (const [k, v] of [['contact_id', contactId], ['owner_id', ownerId], ['channel_id', channelId]] as const) {
      if (v && !isUuid(v)) throw badRequest(`'${k}' deve ser um UUID`);
    }
    if (status && !['open', 'pending', 'closed'].includes(status)) {
      throw badRequest("'status' deve ser open, pending ou closed");
    }

    let query = ctx.db.from('conversations').select(CONVERSATION_SELECT).eq('is_group', false);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);
    if (ownerId) query = query.contains('owner_ids', [ownerId]);
    if (url.searchParams.get('unassigned') === 'true') query = query.eq('owner_ids', '{}');
    if (channelId) query = query.contains('channel_ids', [channelId]);
    if (url.searchParams.get('unread') === 'true') query = query.gt('unread_count', 0);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) =>
        serializeConversation(normalizeConversation(r as Conversation))
      ),
      nextCursor
    );
});

export const POST = apiRoute('conversations:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const digits = parseTypedPhone(typeof body.phone === 'string' ? body.phone : null);
  if (!digits) {
    throw badRequest("'phone' inválido: use +55 DDD número, ou só DDD e número para o Brasil");
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;

  // Vetted core: find-or-create contact + conversation in accountId.
  const resolved = await resolveConversationByPhone(ctx.db.trusted, ctx.accountId, `+${digits}`, name);

  const { data } = await ctx.db
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', resolved.conversationId)
    .maybeSingle();
  if (!data) return fail('internal', 'Failed to start conversation', 500);
  return ok(
    {
      ...serializeConversation(normalizeConversation(data as Conversation)),
      contact_created: resolved.contactCreated,
    },
    resolved.contactCreated ? 201 : 200
  );
});
