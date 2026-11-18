// ============================================================
// GET    /api/v1/quick-replies/{id}                  (quick_replies:read)
// PATCH  /api/v1/quick-replies/{id} — title and/or content; sending
//        `kind` switches type and needs that type's content
//                                                    (quick_replies:write)
// DELETE /api/v1/quick-replies/{id}                 (quick_replies:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { optionalString, readJsonObject } from '@/lib/api/v1/body';
import {
  QUICK_REPLY_COLUMNS,
  readQuickReplyContent,
  serializeQuickReply,
} from '@/lib/api/v1/quick-replies';

const notFound = () => fail('not_found', 'Quick reply not found', 404);

export const GET = apiRoute<{ id: string }>('quick_replies:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('quick_replies').select(QUICK_REPLY_COLUMNS).eq('id', id).maybeSingle();
  return data ? ok(serializeQuickReply(data as Record<string, unknown>)) : notFound();
});

export const PATCH = apiRoute<{ id: string }>('quick_replies:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data: current } = await ctx.db.from('quick_replies').select('id, kind').eq('id', id).maybeSingle();
  if (!current) return notFound();
  const body = await readJsonObject(request);

  const patch: Record<string, unknown> = {};
  const title = optionalString(body, 'title', 100);
  if (title === null || title === '') throw badRequest("'title' não pode ficar vazio");
  if (title !== undefined) patch.title = title;
  if ('kind' in body || 'content_text' in body || 'interactive_payload' in body) {
    Object.assign(patch, readQuickReplyContent(body, 'kind' in body ? body.kind : current.kind));
  }
  if (Object.keys(patch).length === 0) throw badRequest('Nada para atualizar');
  patch.updated_at = new Date().toISOString();

  const { data, error } = await ctx.db
    .from('quick_replies')
    .update(patch)
    .eq('id', id)
    .select(QUICK_REPLY_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update quick reply', 500);
  return data ? ok(serializeQuickReply(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('quick_replies:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data, error } = await ctx.db.from('quick_replies').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete quick reply', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
