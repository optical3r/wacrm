import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from './encryption'
import { DAPI_ACCESS_TOKEN, dapiClient, dapiPhoneNumberId, hasDapiApiKey } from './dapi'

/**
 * Bookkeeping shared by the D-API connect route and its webhook: keep
 * dapi_sessions and whatsapp_config in step with each session's state.
 * A Starter account's numbers belong to the company (migration 056):
 * owner / admin connect them, and each D-API session points at the
 * number it connects (dapi_sessions.channel_id). Service-role client only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>

export const NUMBER_LIMIT_MESSAGE = 'Esta conta já usa todos os números do plano. Fale com o suporte para aumentar o limite.'

/** Postgres error raised by enforce_whatsapp_number_limit (migration 051). */
export function isNumberLimitError(error: { message?: string; hint?: string } | null | undefined): boolean {
  return Boolean(error && (error.hint === 'whatsapp_number_limit' || /number limit reached/.test(error.message ?? '')))
}

export const NUMBER_IN_OTHER_WORKSPACE_MESSAGE =
  'Este número já está conectado em outro workspace. Desconecte-o lá antes de conectar aqui.'

/** Whether this phone is connected right now through another workspace. */
export async function connectedElsewhere(
  admin: Admin,
  accountId: string,
  sessionId: string,
  phone: string,
): Promise<boolean> {
  const { data } = await admin
    .from('dapi_sessions')
    .select('session_id')
    .eq('phone', phone)
    .eq('status', 'connected')
    .neq('account_id', accountId)
    .neq('session_id', sessionId)
    .limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Save a connected session as a number of the account: the number the
 * session was started for, else the number that already had this phone,
 * else a new one. Returns an error message, or null.
 */
export async function saveDapiConnection(
  admin: Admin,
  args: { accountId: string; connectedBy: string | null; sessionId: string; phone: string | null },
): Promise<string | null> {
  const { accountId, sessionId, phone } = args
  const now = new Date().toISOString()
  const phoneNumberId = dapiPhoneNumberId(sessionId)

  // One WhatsApp number lives in one workspace only (migration 061): a
  // phone already connected in another workspace is refused and this
  // pairing is logged out.
  if (phone && (await connectedElsewhere(admin, accountId, sessionId, phone))) {
    if (hasDapiApiKey()) {
      await dapiClient()
        .sessions.delete(sessionId)
        .catch((err: unknown) => console.warn('[dapi] logout failed:', err instanceof Error ? err.message : err))
    }
    await admin
      .from('dapi_sessions')
      .update({ status: 'disconnected', phone, updated_at: now })
      .eq('session_id', sessionId)
    return NUMBER_IN_OTHER_WORKSPACE_MESSAGE
  }

  await admin
    .from('dapi_sessions')
    .update({ status: 'connected', ...(phone ? { phone } : {}), updated_at: now })
    .eq('session_id', sessionId)

  const { data: session } = await admin
    .from('dapi_sessions')
    .select('channel_id, created_by')
    .eq('session_id', sessionId)
    .maybeSingle()
  let channelId = (session as { channel_id?: string | null } | null)?.channel_id ?? null

  // Same phone paired again as "new": reuse its number, keeping history
  // and the linked attendants.
  if (!channelId && phone) {
    const { data: twin } = await admin
      .from('dapi_sessions')
      .select('channel_id')
      .eq('account_id', accountId)
      .eq('phone', phone)
      .not('channel_id', 'is', null)
      .neq('session_id', sessionId)
      .limit(1)
      .maybeSingle()
    channelId = (twin as { channel_id?: string | null } | null)?.channel_id ?? null
  }

  const { data: existing } = channelId
    ? await admin.from('whatsapp_config').select('id, phone_number_id, status').eq('id', channelId).maybeSingle()
    : await admin
        .from('whatsapp_config')
        .select('id, phone_number_id, status')
        .eq('account_id', accountId)
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle()
  const row = existing as { id: string; phone_number_id: string; status: string } | null

  const fields = {
    phone_number_id: phoneNumberId,
    waba_id: null,
    access_token: encrypt(DAPI_ACCESS_TOKEN),
    status: 'connected',
    connected_at: now,
    registered_at: now,
    subscribed_apps_at: now,
    last_registration_error: null,
    updated_at: now,
  }

  if (row) {
    if (!(row.phone_number_id === phoneNumberId && row.status === 'connected')) {
      const { error } = await admin.from('whatsapp_config').update(fields).eq('id', row.id)
      if (error) {
        console.error('[dapi] failed to update whatsapp_config:', error.message)
        return 'Não foi possível salvar a conexão.'
      }
    }
    await admin.from('dapi_sessions').update({ channel_id: row.id }).eq('session_id', sessionId)
    return null
  }

  // whatsapp_config.user_id is NOT NULL: whoever connected it, else the
  // account owner.
  let connectedBy = args.connectedBy ?? (session as { created_by?: string | null } | null)?.created_by ?? null
  if (!connectedBy) {
    const { data: acct } = await admin.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
    connectedBy = (acct as { owner_user_id?: string } | null)?.owner_user_id ?? null
  }
  if (!connectedBy) return 'Não foi possível salvar a conexão.'

  const { data: hasDefault } = await admin
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle()
  const { data: inserted, error } = await admin
    .from('whatsapp_config')
    .insert({
      ...fields,
      account_id: accountId,
      user_id: connectedBy,
      owner_user_id: connectedBy,
      is_default: !hasDefault,
    })
    .select('id')
    .single()
  if (error) {
    if (isNumberLimitError(error)) return NUMBER_LIMIT_MESSAGE
    console.error('[dapi] failed to save whatsapp_config:', error.message)
    return 'Não foi possível salvar a conexão.'
  }
  await admin
    .from('dapi_sessions')
    .update({ channel_id: (inserted as { id: string }).id })
    .eq('session_id', sessionId)
  return null
}

/** Mark one session and its number as disconnected. History is kept. */
export async function markDapiDisconnected(admin: Admin, sessionId: string): Promise<void> {
  const now = new Date().toISOString()
  await admin.from('dapi_sessions').update({ status: 'disconnected', updated_at: now }).eq('session_id', sessionId)
  await admin
    .from('whatsapp_config')
    .update({ status: 'disconnected', updated_at: now })
    .eq('phone_number_id', dapiPhoneNumberId(sessionId))
}

/**
 * Log out every D-API session of an account. Best effort: used by /admin
 * (plan change, manual disconnect) and never fails the caller.
 */
export async function logoutDapiSession(admin: Admin, accountId: string): Promise<void> {
  try {
    const { data: rows } = await admin.from('dapi_sessions').select('session_id').eq('account_id', accountId)
    for (const row of (rows ?? []) as Array<{ session_id: string }>) {
      if (hasDapiApiKey()) {
        await dapiClient().sessions.delete(row.session_id).catch((err: unknown) => {
          console.warn('[dapi] logout failed:', err instanceof Error ? err.message : err)
        })
      }
      await markDapiDisconnected(admin, row.session_id)
    }
  } catch (err) {
    console.warn('[dapi] logout skipped:', err instanceof Error ? err.message : err)
  }
}
