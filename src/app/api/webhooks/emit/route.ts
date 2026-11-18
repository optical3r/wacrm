import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { DB_EMITTED_EVENTS, type WebhookEvent } from '@/lib/webhooks/events'

/**
 * Relay for webhook events raised inside the database (migration 063).
 *
 * Deals, tags, owners and flow runs are written from many places (the
 * dashboard writes deals straight from the browser), so their events
 * come from table triggers. A trigger calls `labcrm_emit_event`, which
 * only fires when the account has an active endpoint subscribed to the
 * event and POSTs { account_id, event, data } here through pg_net. This
 * route signs and delivers it with the same code as every other event.
 *
 * Auth: the `x-cron-secret` header, checked against
 * AUTOMATION_CRON_SECRET in constant time (same secret as the crons,
 * read by the database from Vault). Only database-emitted events are
 * accepted, so the secret cannot forge a message.received.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'emit not configured' }, { status: 503 })
  }
  const suppliedBuf = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as {
    account_id?: unknown
    event?: unknown
    data?: unknown
  } | null
  if (!body || typeof body.account_id !== 'string' || !UUID.test(body.account_id)) {
    return NextResponse.json({ error: 'invalid account_id' }, { status: 400 })
  }
  if (!DB_EMITTED_EVENTS.includes(body.event as WebhookEvent)) {
    return NextResponse.json({ error: 'invalid event' }, { status: 400 })
  }

  await dispatchWebhookEvent(supabaseAdmin(), body.account_id, body.event as WebhookEvent, body.data ?? {})
  return NextResponse.json({ ok: true })
}
