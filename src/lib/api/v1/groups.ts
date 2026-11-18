// Shared shape for the v1 group endpoints (plano Starter).

export const GROUP_SELECT =
  'id, contact_id, last_message_text, last_message_at, unread_count, channel_ids, created_at, contact:contacts(name, wa_group_id, group_hidden_at)';

type Row = Record<string, unknown>;

export function serializeGroup(row: Row) {
  const raw = row.contact as Row | Row[] | null | undefined;
  const contact = Array.isArray(raw) ? raw[0] : raw;
  return {
    id: row.id as string,
    contact_id: row.contact_id as string,
    name: (contact?.name as string | null) ?? null,
    hidden_at: (contact?.group_hidden_at as string | null) ?? null,
    last_message_text: (row.last_message_text as string | null) ?? null,
    last_message_at: (row.last_message_at as string | null) ?? null,
    unread_count: Number(row.unread_count ?? 0),
    channel_ids: (row.channel_ids as string[] | null) ?? [],
    created_at: row.created_at as string,
  };
}
