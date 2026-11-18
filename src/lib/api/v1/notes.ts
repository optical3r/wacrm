// Shared note shape for the v1 endpoints.

export const NOTE_COLUMNS = 'id, contact_id, user_id, note_text, created_at';

export function serializeNote(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    contact_id: row.contact_id as string,
    author_id: (row.user_id as string | null) ?? null,
    text: row.note_text as string,
    created_at: row.created_at as string,
  };
}
