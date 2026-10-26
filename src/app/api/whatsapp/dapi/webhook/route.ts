import { NextResponse, after } from 'next/server'
import { createHash } from 'node:crypto'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { processWebhook } from '@/lib/whatsapp/webhook-processor'
import { translateDapiWebhook } from '@/lib/whatsapp/dapi-webhook'
import { dapiPhoneNumberId } from '@/lib/whatsapp/dapi'
import { markDapiDisconnected, saveDapiConnection } from '@/lib/whatsapp/dapi-connection'

/**
 * Inbound events for Starter accounts (QR-code connection via D-API).
 *
 * D-API documents no signature for session webhooks, so the URL itself
 * is the secret: `?token=` is random per session and only its SHA-256
 * lives in dapi_sessions. Payloads are translated into Meta's webhook
 * shape and handed to the same processor the official API uses.
 */

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: SupabaseClient<any> | null = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

/** How long an echo waits for our own send to land in `messages`. */
const ECHO_SETTLE_MS = 4000
const LOG_RETENTION_MS = 3 * 24 * 3600 * 1000

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: session } = await supabaseAdmin()
    .from('dapi_sessions')
    .select('account_id, session_id, status, created_by')
    .eq('webhook_token_hash', createHash('sha256').update(token).digest('hex'))
    .maybeSingle()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Answer fast; D-API retries slow webhooks.
  after(() => handle(session, payload))
  return NextResponse.json({ ok: true })
}

interface SessionRow {
  account_id: string
  session_id: string
  status: string
  created_by: string | null
}

async function handle(session: SessionRow, payload: unknown) {
  const admin = supabaseAdmin()
  const phoneNumberId = dapiPhoneNumberId(session.session_id)
  const translated = translateDapiWebhook(payload, phoneNumberId)

  // Raw copy for checking the translation against real traffic.
  await admin
    .from('dapi_webhook_log')
    .insert({ session_id: session.session_id, event: translated.event || null, payload })
    .then(({ error }) => error && console.error('[dapi] webhook log failed:', error.message))
  if (Math.random() < 0.02) {
    await admin
      .from('dapi_webhook_log')
      .delete()
      .lt('created_at', new Date(Date.now() - LOG_RETENTION_MS).toISOString())
  }

  try {
    if (translated.connection) await applyConnection(session, translated.connection)
    if (!translated.body) return

    // fromMe covers both replies typed on the phone and our own sends.
    // Ours are already in `messages` (or about to be): drop those so they
    // are not stored twice, nor read as "a human answered" by the flows.
    if (translated.echoIds.length) {
      await new Promise((r) => setTimeout(r, ECHO_SETTLE_MS))
      const { data: known } = await admin
        .from('messages')
        .select('message_id')
        .in('message_id', translated.echoIds)
      const ours = new Set((known ?? []).map((m: { message_id: string }) => m.message_id))
      for (const entry of translated.body.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'smb_message_echoes') continue
          const value = change.value as unknown as { message_echoes?: Array<{ id: string }> }
          value.message_echoes = value.message_echoes?.filter((e) => !ours.has(e.id))
        }
      }
    }

    await processWebhook(translated.body)
  } catch (err) {
    console.error('[dapi] webhook processing failed:', err instanceof Error ? err.message : err)
  }
}

async function applyConnection(
  session: SessionRow,
  connection: NonNullable<ReturnType<typeof translateDapiWebhook>['connection']>,
) {
  const admin = supabaseAdmin()
  if (connection.status === 'disconnected') return markDapiDisconnected(admin, session.account_id)
  if (connection.status === 'connected') {
    // Connected while nobody had the settings page open: save it here too.
    await saveDapiConnection(admin, {
      accountId: session.account_id,
      userId: session.created_by,
      sessionId: session.session_id,
      phone: connection.phone ?? null,
    })
    return
  }
  await admin
    .from('dapi_sessions')
    .update({ status: connection.status, updated_at: new Date().toISOString() })
    .eq('account_id', session.account_id)
}
