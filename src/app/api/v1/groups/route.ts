// ============================================================
// GET /api/v1/groups — the WhatsApp groups the account's numbers are
// in (conversations:read). Plano Starter only.
//   ?hidden=true|false  (default: only the visible ones)
// Read a group's messages with GET /api/v1/conversations/{id}/messages
// and write with POST /api/v1/conversations/{id}/messages.
// Groups never run automations or flows.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { okList, fail } from '@/lib/api/v1/respond';
import { GROUP_SELECT, serializeGroup } from '@/lib/api/v1/groups';

type Row = Record<string, unknown>;

export const GET = apiRoute('conversations:read', async (ctx, request) => {
  requirePlan(ctx, 'starter', 'Grupos');
  const hidden = new URL(request.url).searchParams.get('hidden') === 'true';
  const { data, error } = await ctx.db
    .from('conversations')
    .select(GROUP_SELECT)
    .eq('is_group', true)
    .order('last_message_at', { ascending: false });
  if (error) return fail('internal', 'Failed to list groups', 500);
  const groups = ((data ?? []) as Row[]).map(serializeGroup).filter((g) => (g.hidden_at !== null) === hidden);
  return okList(groups, null);
});
