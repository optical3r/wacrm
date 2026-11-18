// ============================================================
// GET  /api/v1/contacts/{id}/tags — the contact's tags   (tags:read)
// POST /api/v1/contacts/{id}/tags — add tags             (tags:write)
//   Body: { "tag_id": "<uuid>" } or { "names": ["vip", "lead quente"] }
//   (names are matched case-insensitively; missing ones are created).
//   Adding fires the "tag added" automations, as in the inbox.
// ============================================================

import { apiRoute, type ApiContext } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, stringArray } from '@/lib/api/v1/body';
import { serializeTag } from '@/lib/api/v1/tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { addContactTagsByName, resolveAuditUserId } from '@/lib/api/v1/contacts';

async function contactTags(ctx: ApiContext, contactId: string) {
  const joins = await ctx.db.child('contact_tags', contactId, 'Contact');
  const { data, error } = await joins.select('tags(id, name, color, created_at)');
  if (error) throw error;
  return ((data ?? []) as { tags: Record<string, unknown> | null }[])
    .map((r) => r.tags)
    .filter((t): t is Record<string, unknown> => Boolean(t))
    .map(serializeTag);
}

export const GET = apiRoute<{ id: string }>('tags:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);
  return okList(await contactTags(ctx, id), null);
});

export const POST = apiRoute<{ id: string }>('tags:write', async (ctx, request, { id }) => {
  if (!isUuid(id) || !(await ctx.db.owns('contacts', id))) {
    return fail('not_found', 'Contact not found', 404);
  }
  const body = await readJsonObject(request);
  const names = stringArray(body, 'names', 20);
  const tagId = typeof body.tag_id === 'string' ? body.tag_id : null;
  if (!tagId && (!names || names.length === 0)) {
    throw badRequest("Envie 'tag_id' ou 'names'");
  }

  // Vetted cores: they check the contact and tag belong to accountId.
  if (tagId) {
    if (!isUuid(tagId)) return fail('not_found', 'Tag not found', 404);
    await addContactTagAndDispatch({ db: ctx.db.trusted, accountId: ctx.accountId, contactId: id, tagId });
  }
  if (names && names.length > 0) {
    const auditUserId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
    await addContactTagsByName(ctx.db.trusted, ctx.accountId, auditUserId, id, names);
  }
  return ok(await contactTags(ctx, id));
});
