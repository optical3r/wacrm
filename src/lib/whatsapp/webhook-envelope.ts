import type { WhatsAppWebhookEntry } from './webhook-processor'

/**
 * Find Meta's `{ entry: [...] }` in a webhook body.
 *
 * Meta posts it as is. Coexy's relay is documented as the same payload,
 * but its deliveries carry an event name ("messages", "account_update"),
 * so the Meta body may come inside an envelope: `{ event, payload }`,
 * `{ event, data }`, `{ body }`, or just the change value
 * (`{ event: "messages", data: { metadata, messages, ... } }`). Every one
 * of those is turned back into Meta's shape so the processor stays
 * unchanged. Returns null when nothing Meta-shaped is found.
 */
export function unwrapWebhookBody(raw: unknown): { entry: WhatsAppWebhookEntry[] } | null {
  return findEntries(raw, 0)
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const NESTED_KEYS = ['payload', 'data', 'body', 'event_data', 'webhook', 'message']

function findEntries(raw: unknown, depth: number): { entry: WhatsAppWebhookEntry[] } | null {
  if (typeof raw === 'string' && depth < 3) {
    try {
      return findEntries(JSON.parse(raw), depth + 1)
    } catch {
      return null
    }
  }
  if (!isObj(raw) || depth > 3) return null

  if (Array.isArray(raw.entry)) return { entry: raw.entry as WhatsAppWebhookEntry[] }

  // A single change: { field, value }.
  if (typeof raw.field === 'string' && isObj(raw.value)) {
    return { entry: [{ id: wabaIdOf(raw), changes: [{ field: raw.field, value: raw.value }] } as WhatsAppWebhookEntry] }
  }

  // Just the change value, named by the envelope's event.
  const field = typeof raw.event === 'string' ? raw.event : typeof raw.type === 'string' ? raw.type : null
  if (field) {
    for (const key of NESTED_KEYS) {
      const value = raw[key]
      if (isObj(value) && looksLikeChangeValue(value)) {
        return { entry: [{ id: wabaIdOf(raw), changes: [{ field, value }] } as WhatsAppWebhookEntry] }
      }
    }
  }
  for (const key of NESTED_KEYS) {
    const found = findEntries(raw[key], depth + 1)
    if (found) return found
  }

  if (looksLikeChangeValue(raw)) {
    return { entry: [{ id: wabaIdOf(raw), changes: [{ field: 'messages', value: raw }] } as WhatsAppWebhookEntry] }
  }
  return null
}

function looksLikeChangeValue(v: Obj): boolean {
  return (
    isObj(v.metadata) ||
    Array.isArray(v.messages) ||
    Array.isArray(v.statuses) ||
    Array.isArray(v.message_echoes)
  )
}

function wabaIdOf(v: Obj): string {
  for (const key of ['waba_id', 'wabaId', 'entry_id']) {
    if (typeof v[key] === 'string') return v[key] as string
  }
  return ''
}

/** Keys (never values) of a body we couldn't read, for the logs. */
export function describeShape(raw: unknown, depth = 0): string {
  if (Array.isArray(raw)) return `[${raw.length ? describeShape(raw[0], depth + 1) : ''}]`
  if (!isObj(raw)) return typeof raw
  if (depth >= 2) return '{…}'
  return `{${Object.keys(raw)
    .slice(0, 15)
    .map((k) => `${k}:${describeShape(raw[k], depth + 1)}`)
    .join(',')}}`
}
