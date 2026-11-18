// ============================================================
// Read the message part of a v1 send body — shared by
// POST /api/v1/messages (by phone) and
// POST /api/v1/conversations/{id}/messages (existing chat).
//
//   { "type": "text", "text": "…" }
//   { "type": "image", "media_url": "…", "text"?: caption, "filename"? }
//   { "type": "template", "template": { "name", "language"?, "params"? } }
//   { "type": "interactive", "interactive_payload": {…} }
//   + "reply_to_message_id"? (same conversation)
//
// Validates before anything is created, so a bad payload 400s
// without side effects.
// ============================================================

import { validateSendMessageParams, type SendMessageParams } from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

export type SendBodyParams = Omit<SendMessageParams, 'conversationId'>;

export function readSendBody(body: Record<string, unknown>): SendBodyParams {
  const type = typeof body.type === 'string' ? body.type : 'text';

  // `params` as an array → legacy positional body params; as an object
  // → structured header/body/button params.
  const template =
    body.template && typeof body.template === 'object'
      ? (body.template as Record<string, unknown>)
      : null;
  const templateParams = Array.isArray(template?.params)
    ? (template.params as unknown[]).filter((p): p is string => typeof p === 'string')
    : undefined;
  const templateMessageParams =
    template?.params && !Array.isArray(template.params) ? template.params : undefined;

  const interactivePayload =
    body.interactive_payload && typeof body.interactive_payload === 'object'
      ? (body.interactive_payload as InteractiveMessagePayload)
      : null;

  const params = {
    messageType: type,
    contentText: typeof body.text === 'string' ? body.text : null,
    mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
    filename: typeof body.filename === 'string' ? body.filename : null,
    templateName: typeof template?.name === 'string' ? template.name : null,
    templateLanguage: typeof template?.language === 'string' ? template.language : null,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId: typeof body.reply_to_message_id === 'string' ? body.reply_to_message_id : null,
  } as SendBodyParams;

  validateSendMessageParams(params);
  return params;
}
