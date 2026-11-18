// Shared shape and body checks for the v1 quick-reply endpoints.

import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { badRequest } from '@/lib/api/v1/respond';
import type { JsonBody } from '@/lib/api/v1/body';

export const QUICK_REPLY_COLUMNS = 'id, title, kind, content_text, interactive_payload, created_at, updated_at';

export function serializeQuickReply(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as 'text' | 'interactive',
    content_text: (row.content_text as string | null) ?? null,
    interactive_payload: row.interactive_payload ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

/**
 * The content columns for a quick reply of `kind`: a text reply needs
 * `content_text`, an interactive one a valid `interactive_payload`
 * (buttons or list, same rules as the dashboard). The other column is
 * cleared so the picker never reads a stale value.
 */
export function readQuickReplyContent(body: JsonBody, kind: unknown): Record<string, unknown> {
  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload);
    if (!result.ok) throw badRequest(result.error);
    return { kind, interactive_payload: body.interactive_payload, content_text: null };
  }
  if (kind !== 'text') throw badRequest("'kind' deve ser text ou interactive");
  const text = typeof body.content_text === 'string' ? body.content_text : '';
  if (!text.trim()) throw badRequest("'content_text' é obrigatório para kind text");
  if (text.length > 4096) throw badRequest("'content_text' passa de 4096 caracteres");
  return { kind, content_text: text, interactive_payload: null };
}
