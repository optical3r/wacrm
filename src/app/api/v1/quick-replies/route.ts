// ============================================================
// GET  /api/v1/quick-replies — list quick replies (quick_replies:read)
// POST /api/v1/quick-replies — create one        (quick_replies:write)
//   { "title", "kind": "text", "content_text" }
//   { "title", "kind": "interactive", "interactive_payload": {...} }
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  QUICK_REPLY_COLUMNS,
  readQuickReplyContent,
  serializeQuickReply,
} from '@/lib/api/v1/quick-replies';

export const GET = apiRoute('quick_replies:read', async (ctx) => {
  const { data, error } = await ctx.db
    .from('quick_replies')
    .select(QUICK_REPLY_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) return fail('internal', 'Failed to list quick replies', 500);
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeQuickReply), null);
});

export const POST = apiRoute('quick_replies:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const title = requiredString(body, 'title', 100);
  const content = readQuickReplyContent(body, body.kind ?? 'text');
  // Vetted core: scopes by accountId itself.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { data, error } = await ctx.db
    .from('quick_replies')
    .insert({ title, ...content, user_id: userId })
    .select(QUICK_REPLY_COLUMNS)
    .single();
  if (error || !data) return fail('internal', 'Failed to create quick reply', 500);
  return ok(serializeQuickReply(data as Record<string, unknown>), 201);
});
