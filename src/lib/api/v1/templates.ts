// Shared shape for the v1 message-template endpoints (plano Pro).

export const TEMPLATE_COLUMNS =
  'id, name, category, language, status, header_type, header_content, header_media_url, body_text, footer_text, buttons, sample_values, rejection_reason, quality_score, submission_error, last_submitted_at, created_at';

export function serializeTemplate(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    name: row.name as string,
    category: row.category as string,
    language: row.language as string,
    status: row.status as string,
    header_type: (row.header_type as string | null) ?? null,
    header_content: (row.header_content as string | null) ?? null,
    header_media_url: (row.header_media_url as string | null) ?? null,
    body_text: row.body_text as string,
    footer_text: (row.footer_text as string | null) ?? null,
    buttons: row.buttons ?? null,
    sample_values: row.sample_values ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    quality_score: (row.quality_score as string | null) ?? null,
    submission_error: (row.submission_error as string | null) ?? null,
    last_submitted_at: (row.last_submitted_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}
