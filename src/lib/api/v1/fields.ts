// Shared custom-field shapes for the v1 endpoints.

export const FIELD_COLUMNS = 'id, field_name, field_type, field_options, created_at';

/** Only free text exists in the CRM today. */
export const FIELD_TYPES = ['text'] as const;

export interface ApiField {
  id: string;
  name: string;
  type: string;
  options: unknown;
  created_at: string;
}

export function serializeField(row: Record<string, unknown>): ApiField {
  return {
    id: row.id as string,
    name: row.field_name as string,
    type: row.field_type as string,
    options: row.field_options ?? null,
    created_at: row.created_at as string,
  };
}
