// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound WhatsApp message landed
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  // Emitted by database triggers (migration 063), so they fire whether
  // the change came from the dashboard, the API, the MCP or a flow.
  'conversation.status_changed', // open / pending / closed
  'conversation.owners_changed', // the lead's owners changed
  'contact.created',
  'contact.deleted',
  'contact.tag_added',
  'contact.tag_removed',
  'deal.created',
  'deal.stage_changed',
  'deal.status_changed', // open / won / lost
  'deal.deleted',
  'flow.started',
  'flow.ended', // completed, timed out, stopped or failed
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'conversation.status_changed': 'A conversation changed status (open/pending/closed)',
  'conversation.owners_changed': "A lead's owners changed",
  'contact.created': 'A contact was created',
  'contact.deleted': 'A contact was deleted',
  'contact.tag_added': 'A tag was added to a contact',
  'contact.tag_removed': 'A tag was removed from a contact',
  'deal.created': 'A deal was created',
  'deal.stage_changed': 'A deal moved to another stage',
  'deal.status_changed': 'A deal was won, lost or reopened',
  'deal.deleted': 'A deal was deleted',
  'flow.started': 'A flow started for a contact',
  'flow.ended': 'A flow run ended (completed, timed out, stopped or failed)',
};

/** Events the database emits through /api/webhooks/emit (migration 063). */
export const DB_EMITTED_EVENTS: readonly WebhookEvent[] = [
  'conversation.status_changed',
  'conversation.owners_changed',
  'contact.created',
  'contact.deleted',
  'contact.tag_added',
  'contact.tag_removed',
  'deal.created',
  'deal.stage_changed',
  'deal.status_changed',
  'deal.deleted',
  'flow.started',
  'flow.ended',
];

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
