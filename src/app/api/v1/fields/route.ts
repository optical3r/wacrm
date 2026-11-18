// ============================================================
// GET  /api/v1/fields — list custom contact fields (scope: fields:read)
// POST /api/v1/fields — create one { "name": "CPF" } (scope: fields:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { FIELD_COLUMNS, FIELD_TYPES, serializeField } from '@/lib/api/v1/fields';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

export const GET = apiRoute('fields:read', async (ctx) => {
  const { data, error } = await ctx.db
    .from('custom_fields')
    .select(FIELD_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) return fail('internal', 'Failed to list fields', 500);
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeField), null);
});

export const POST = apiRoute('fields:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 60);
  const type = typeof body.type === 'string' ? body.type : 'text';
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    throw badRequest(`'type' deve ser um de: ${FIELD_TYPES.join(', ')}`);
  }

  const { data: all } = await ctx.db.from('custom_fields').select('id, field_name');
  if (((all ?? []) as { field_name: string }[]).some((f) => f.field_name.toLowerCase() === name.toLowerCase())) {
    throw badRequest('Já existe um campo com esse nome');
  }

  // Vetted core: scopes by accountId itself.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { data, error } = await ctx.db
    .from('custom_fields')
    .insert({ field_name: name, field_type: type, user_id: userId })
    .select(FIELD_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[api/v1/fields] create error:', error);
    return fail('internal', 'Failed to create field', 500);
  }
  return ok(serializeField(data as Record<string, unknown>), 201);
});
