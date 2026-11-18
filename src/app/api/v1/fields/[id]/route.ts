// ============================================================
// PATCH  /api/v1/fields/{id} — rename a field            (fields:write)
// DELETE /api/v1/fields/{id} — delete it and every value (fields:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { FIELD_COLUMNS, serializeField } from '@/lib/api/v1/fields';

const notFound = () => fail('not_found', 'Field not found', 404);

export const PATCH = apiRoute<{ id: string }>('fields:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 60);
  const { data: clash } = await ctx.db.from('custom_fields').select('id, field_name').neq('id', id);
  if (((clash ?? []) as { field_name: string }[]).some((f) => f.field_name.toLowerCase() === name.toLowerCase())) {
    throw badRequest('Já existe um campo com esse nome');
  }
  const { data, error } = await ctx.db
    .from('custom_fields')
    .update({ field_name: name })
    .eq('id', id)
    .select(FIELD_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update field', 500);
  return data ? ok(serializeField(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('fields:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data, error } = await ctx.db.from('custom_fields').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete field', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
