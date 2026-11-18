// Shared tag shape for the v1 tag endpoints.

export const TAG_COLUMNS = 'id, name, color, created_at';

export interface ApiTag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export function serializeTag(row: Record<string, unknown>): ApiTag {
  return {
    id: row.id as string,
    name: row.name as string,
    color: row.color as string,
    created_at: row.created_at as string,
  };
}
