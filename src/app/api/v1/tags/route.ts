// ============================================================
// GET  /api/v1/tags — list the workspace's tags (scope: tags:read)
// POST /api/v1/tags — create a tag             (scope: tags:write)
//
// Names are unique per workspace, case-insensitive: creating a name
// that exists returns the existing tag with 200 instead of 201.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { optionalColor, readJsonObject, requiredString } from '@/lib/api/v1/body';
import { TAG_COLUMNS, serializeTag } from '@/lib/api/v1/tags';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

export const GET = apiRoute('tags:read', async (ctx) => {
  const { data, error } = await ctx.db.from('tags').select(TAG_COLUMNS).order('name', { ascending: true });
  if (error) {
    console.error('[api/v1/tags] list error:', error);
    return fail('internal', 'Failed to list tags', 500);
  }
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeTag), null);
});

export const POST = apiRoute('tags:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 60);
  const color = optionalColor(body) ?? '#3b82f6';

  const { data: all, error: readErr } = await ctx.db.from('tags').select(TAG_COLUMNS);
  if (readErr) return fail('internal', 'Failed to create tag', 500);
  const same = ((all ?? []) as Record<string, unknown>[]).find(
    (t) => String(t.name).toLowerCase() === name.toLowerCase()
  );
  if (same) return ok(serializeTag(same), 200);

  // Vetted core: scopes by accountId itself.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { data, error } = await ctx.db
    .from('tags')
    .insert({ name, color, user_id: userId })
    .select(TAG_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[api/v1/tags] create error:', error);
    return fail('internal', 'Failed to create tag', 500);
  }
  return ok(serializeTag(data as Record<string, unknown>), 201);
});
