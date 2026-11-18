// ============================================================
// GET  /api/v1/contacts/{id}/notes — the contact's notes, newest first
//                                    (scope: notes:read)
// POST /api/v1/contacts/{id}/notes — add a note { "text": "…" }
//                                    (scope: notes:write)
// API notes are authored by the workspace's default user, like every
// other API write.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { NOTE_COLUMNS, serializeNote } from '@/lib/api/v1/notes';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

const contactNotFound = () => fail('not_found', 'Contact not found', 404);

export const GET = apiRoute<{ id: string }>('notes:read', async (ctx, _request, { id }) => {
  if (!isUuid(id) || !(await ctx.db.owns('contacts', id))) return contactNotFound();
  const { data, error } = await ctx.db
    .from('contact_notes')
    .select(NOTE_COLUMNS)
    .eq('contact_id', id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return fail('internal', 'Failed to list notes', 500);
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeNote), null);
});

export const POST = apiRoute<{ id: string }>('notes:write', async (ctx, request, { id }) => {
  if (!isUuid(id) || !(await ctx.db.owns('contacts', id))) return contactNotFound();
  const body = await readJsonObject(request);
  const text = requiredString(body, 'text', 5000);
  // Vetted core: scopes by accountId itself.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { data, error } = await ctx.db
    .from('contact_notes')
    .insert({ contact_id: id, user_id: userId, note_text: text })
    .select(NOTE_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[api/v1/notes] create error:', error);
    return fail('internal', 'Failed to create note', 500);
  }
  return ok(serializeNote(data as Record<string, unknown>), 201);
});
