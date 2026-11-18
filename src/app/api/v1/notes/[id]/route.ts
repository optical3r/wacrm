// ============================================================
// PATCH  /api/v1/notes/{id} — edit a note's text { "text": "…" } (notes:write)
// DELETE /api/v1/notes/{id} — delete a note                      (notes:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { NOTE_COLUMNS, serializeNote } from '@/lib/api/v1/notes';

const notFound = () => fail('not_found', 'Note not found', 404);

export const PATCH = apiRoute<{ id: string }>('notes:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const body = await readJsonObject(request);
  const text = requiredString(body, 'text', 5000);
  const { data, error } = await ctx.db
    .from('contact_notes')
    .update({ note_text: text })
    .eq('id', id)
    .select(NOTE_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update note', 500);
  return data ? ok(serializeNote(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('notes:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data, error } = await ctx.db.from('contact_notes').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete note', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
