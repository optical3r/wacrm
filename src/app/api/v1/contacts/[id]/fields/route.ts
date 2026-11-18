// ============================================================
// GET /api/v1/contacts/{id}/fields — every custom field with this
//     contact's value (null when empty)                (fields:read)
// PUT /api/v1/contacts/{id}/fields — set values        (fields:write)
//     Body: { "values": { "<field id>": "texto" | null } }
//     null (or "") clears a value. Fields not listed are untouched.
// ============================================================

import { apiRoute, type ApiContext } from '@/lib/auth/api-context';
import { okList, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';

async function fieldValues(ctx: ApiContext, contactId: string) {
  const values = await ctx.db.child('contact_custom_values', contactId, 'Contact');
  const [{ data: fields, error: fErr }, { data: rows, error: vErr }] = await Promise.all([
    ctx.db.from('custom_fields').select('id, field_name, field_type').order('created_at', { ascending: true }),
    values.select('custom_field_id, value'),
  ]);
  if (fErr || vErr) throw fErr ?? vErr;
  const byField = new Map(
    ((rows ?? []) as { custom_field_id: string; value: string | null }[]).map((r) => [r.custom_field_id, r.value])
  );
  return ((fields ?? []) as { id: string; field_name: string; field_type: string }[]).map((f) => ({
    field_id: f.id,
    name: f.field_name,
    type: f.field_type,
    value: byField.get(f.id) ?? null,
  }));
}

export const GET = apiRoute<{ id: string }>('fields:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);
  return okList(await fieldValues(ctx, id), null);
});

export const PUT = apiRoute<{ id: string }>('fields:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);
  const body = await readJsonObject(request);
  const input = body.values;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest("'values' deve ser um objeto { id_do_campo: valor }");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) throw badRequest("'values' está vazio");
  if (entries.length > 100) throw badRequest('No máximo 100 campos por chamada');

  // Every field id must be one of this workspace's fields.
  const { data: fields } = await ctx.db.from('custom_fields').select('id');
  const known = new Set(((fields ?? []) as { id: string }[]).map((f) => f.id));
  const set: { custom_field_id: string; value: string }[] = [];
  const clear: string[] = [];
  for (const [fieldId, value] of entries) {
    if (!known.has(fieldId)) return fail('not_found', `Field ${fieldId} not found`, 404);
    if (value === null || value === '') clear.push(fieldId);
    else if (typeof value === 'string' && value.length <= 2000) set.push({ custom_field_id: fieldId, value });
    else throw badRequest(`O valor de ${fieldId} deve ser texto (até 2000 caracteres) ou null`);
  }

  // child() 404s unless the contact is this workspace's.
  const values = await ctx.db.child('contact_custom_values', id, 'Contact');
  if (set.length > 0) {
    const { error } = await values.upsert(set, { onConflict: 'contact_id,custom_field_id' });
    if (error) return fail('internal', 'Failed to save field values', 500);
  }
  if (clear.length > 0) {
    const { error } = await values.delete().in('custom_field_id', clear);
    if (error) return fail('internal', 'Failed to save field values', 500);
  }
  return okList(await fieldValues(ctx, id), null);
});
