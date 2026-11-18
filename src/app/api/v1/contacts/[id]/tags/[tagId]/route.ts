// DELETE /api/v1/contacts/{id}/tags/{tagId} — take a tag off a contact
// (scope: tags:write). The tag itself stays.

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { removeContactTag } from '@/lib/contacts/tag-write';

export const DELETE = apiRoute<{ id: string; tagId: string }>(
  'tags:write',
  async (ctx, _request, { id, tagId }) => {
    if (!isUuid(id)) return fail('not_found', 'Contact not found', 404);
    if (!isUuid(tagId)) return fail('not_found', 'Tag not found', 404);
    // Vetted core: checks contact and tag belong to accountId (404 otherwise).
    await removeContactTag(ctx.db.trusted, { accountId: ctx.accountId, contactId: id, tagId });
    return ok({ contact_id: id, tag_id: tagId, removed: true });
  }
);
