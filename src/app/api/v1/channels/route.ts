// ============================================================
// GET /api/v1/channels — the workspace's WhatsApp numbers and the
// attendants linked to each (channels:read).
//
// Read-only and token-free: access tokens, verify tokens and the
// provider keys never leave the server. Connecting or removing a
// number stays in the dashboard.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail } from '@/lib/api/v1/respond';

// Explicit allow-list: never `*` on whatsapp_config (it holds tokens).
const CHANNEL_COLUMNS =
  'id, label, phone_number_id, status, is_default, read_groups, sign_messages, connected_at, created_at';

type Row = Record<string, unknown>;

export const GET = apiRoute('channels:read', async (ctx) => {
  const { data, error } = await ctx.db
    .from('whatsapp_config')
    .select(CHANNEL_COLUMNS)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) return fail('internal', 'Failed to list channels', 500);

  const { data: links } = await ctx.db.from('whatsapp_channel_members').select('channel_id, user_id');
  const members = new Map<string, string[]>();
  for (const l of (links ?? []) as Row[]) {
    const list = members.get(l.channel_id as string) ?? [];
    list.push(l.user_id as string);
    members.set(l.channel_id as string, list);
  }

  return okList(
    ((data ?? []) as Row[]).map((c) => ({
      id: c.id,
      label: c.label ?? null,
      phone_number_id: c.phone_number_id ?? null,
      status: c.status ?? null,
      is_default: Boolean(c.is_default),
      read_groups: Boolean(c.read_groups),
      sign_messages: Boolean(c.sign_messages),
      connected_at: c.connected_at ?? null,
      member_ids: members.get(c.id as string) ?? [],
    })),
    null
  );
});
