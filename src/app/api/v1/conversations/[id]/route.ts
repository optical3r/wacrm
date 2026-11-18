// ============================================================
// GET   /api/v1/conversations/{id} — read one conversation
//       (scope: conversations:read). A foreign id → 404.
// PATCH /api/v1/conversations/{id} — change status and/or lead owners
//       (scope: conversations:write)
//       Body: { "status": "open" | "pending" | "closed",
//               "owner_ids": ["<user id>", …] }   // [] = no owner
//       Owners must be members of the workspace. New owners are
//       notified, as when it is done in the inbox.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export const GET = apiRoute<{ id: string }>('conversations:read', async (ctx, _request, { id }) => {
    const { data, error } = await ctx.db
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
});

export const PATCH = apiRoute<{ id: string }>('conversations:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);
  const body = await readJsonObject(request);
  const updates: Record<string, unknown> = {};

  if ('status' in body) {
    if (!['open', 'pending', 'closed'].includes(body.status as string)) {
      throw badRequest("'status' deve ser open, pending ou closed");
    }
    updates.status = body.status;
  }

  if ('owner_ids' in body) {
    const raw = body.owner_ids;
    if (!Array.isArray(raw) || raw.length > 20 || !raw.every(isUuid)) {
      throw badRequest("'owner_ids' deve ser uma lista de IDs de usuário (até 20)");
    }
    const owners = [...new Set(raw as string[])];
    if (owners.length > 0) {
      const { data: members } = await ctx.db
        .from('account_memberships')
        .select('user_id')
        .in('user_id', owners);
      const memberIds = new Set(((members ?? []) as { user_id: string }[]).map((m) => m.user_id));
      const stranger = owners.find((o) => !memberIds.has(o));
      if (stranger) throw badRequest(`O usuário ${stranger} não é membro deste workspace`);
    }
    updates.owner_ids = owners;
  }

  if (Object.keys(updates).length === 0) throw badRequest('Nada para atualizar');
  updates.updated_at = new Date().toISOString();

  const { data, error } = await ctx.db
    .from('conversations')
    .update(updates)
    .eq('id', id)
    .eq('is_group', false)
    .select(CONVERSATION_SELECT)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/conversations] update error:', error);
    return fail('internal', 'Failed to update conversation', 500);
  }
  if (!data) return fail('not_found', 'Conversation not found', 404);
  return ok(serializeConversation(normalizeConversation(data as Conversation)));
});
