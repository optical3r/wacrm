// ============================================================
// GET   /api/v1/contacts/{id} — read a contact  (scope: contacts:read)
// PATCH /api/v1/contacts/{id} — update a contact (scope: contacts:write)
//
// Both are account-scoped: a contact belonging to another account
// returns 404 (never 403 — don't reveal it exists elsewhere).
// PATCH updates only the fields present in the body; pass `tags` (an
// array of tag names) to replace the contact's tags.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import {
  getContactById,
  setContactTags,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';

export const GET = apiRoute<{ id: string }>('contacts:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);
  // Vetted core helper: scopes by accountId itself.
  const contact = await getContactById(ctx.db.trusted, ctx.accountId, id);
  if (!contact) return fail('not_found', 'Contact not found', 404);
  return ok(contact);
});

export const PATCH = apiRoute<{ id: string }>('contacts:write', async (ctx, request, { id }) => {
    if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Verify the contact is in this account before mutating anything.
    const existing = await getContactById(ctx.db.trusted, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Contact not found', 404);

    // Build a partial update from the provided scalar fields. A field
    // is updated only when its key is PRESENT (so omitted fields are
    // untouched); `null` clears it, a string sets it, and any other
    // type is a 400 rather than a silently-ignored no-op.
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || typeof value === 'string') {
        updates[field] = value;
      } else {
        return fail('bad_request', `'${field}' must be a string or null`, 400);
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await ctx.db.from('contacts').update(updates).eq('id', id);
      if (error) {
        console.error('[api/v1/contacts] update error:', error);
        return fail('internal', 'Failed to update contact', 500);
      }
    }

    if (Array.isArray(body.tags)) {
      const auditUserId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
      await setContactTags(
        ctx.db.trusted,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t): t is string => typeof t === 'string')
      );
    }

    const contact = await getContactById(ctx.db.trusted, ctx.accountId, id);
    return ok(contact);
});
