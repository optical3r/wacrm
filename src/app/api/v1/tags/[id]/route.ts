// ============================================================
// GET    /api/v1/tags/{id} — read a tag            (tags:read)
// PATCH  /api/v1/tags/{id} — rename / recolor      (tags:write)
// DELETE /api/v1/tags/{id} — delete; it leaves every contact (tags:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { optionalColor, optionalString, readJsonObject } from '@/lib/api/v1/body';
import { TAG_COLUMNS, serializeTag } from '@/lib/api/v1/tags';

const notFound = () => fail('not_found', 'Tag not found', 404);

export const GET = apiRoute<{ id: string }>('tags:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('tags').select(TAG_COLUMNS).eq('id', id).maybeSingle();
  return data ? ok(serializeTag(data as Record<string, unknown>)) : notFound();
});

export const PATCH = apiRoute<{ id: string }>('tags:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const body = await readJsonObject(request);
  const updates: Record<string, unknown> = {};
  const name = optionalString(body, 'name', 60);
  if (name === null || name === '') throw badRequest("'name' não pode ficar vazio");
  if (name !== undefined) {
    const { data: clash } = await ctx.db.from('tags').select('id, name').neq('id', id);
    if (((clash ?? []) as { name: string }[]).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw badRequest('Já existe uma etiqueta com esse nome');
    }
    updates.name = name;
  }
  const color = optionalColor(body);
  if (color) updates.color = color;
  if (Object.keys(updates).length === 0) throw badRequest('Nada para atualizar');

  const { data, error } = await ctx.db
    .from('tags')
    .update(updates)
    .eq('id', id)
    .select(TAG_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update tag', 500);
  return data ? ok(serializeTag(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('tags:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data, error } = await ctx.db.from('tags').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete tag', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
