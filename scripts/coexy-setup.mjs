#!/usr/bin/env node
/**
 * Coexy helper for WHATSAPP_PROVIDER=coexy installs.
 *
 *   node scripts/coexy-setup.mjs channels
 *       Lists the org's channels with what Settings → WhatsApp needs
 *       (phone_number_id, waba_id, channel_token) and the connect_url
 *       for channels that still need the number connected.
 *
 *   node scripts/coexy-setup.mjs create-channel "Nome do canal"
 *       Creates a channel and prints its connect_url.
 *
 *   node scripts/coexy-setup.mjs webhook https://seu-dominio/api/whatsapp/webhook
 *       Registers our webhook for all channels and prints the
 *       hmac_secret ONCE: put it in COEXY_HMAC_SECRET right away.
 *
 * Needs COEXY_API_KEY (crt_pk_...) in the environment or .env.local.
 */
import { readFileSync } from 'node:fs'

const API = 'https://api.coexy.com.br/functions/v1/api'

function loadEnvLocal() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // no .env.local — rely on the real environment
  }
}

async function coexy(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-api-key': process.env.COEXY_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 429) throw new Error(`Rate limit; tente de novo em ${res.headers.get('Retry-After')}s`)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data
}

loadEnvLocal()
if (!process.env.COEXY_API_KEY) {
  console.error('Defina COEXY_API_KEY (Painel Coexy → Configurações → API Keys).')
  process.exit(1)
}

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'channels') {
  const result = await coexy('GET', '/channels')
  const channels = Array.isArray(result) ? result : (result?.data ?? result?.channels ?? [])
  for (const c of channels) {
    console.log(`\n${c.name} [${c.status}] ${c.display_phone_number ?? ''}`)
    console.log(`  phone_number_id: ${c.phone_number_id ?? '(conecte o número primeiro)'}`)
    console.log(`  waba_id:         ${c.waba_id ?? '-'}`)
    console.log(`  channel_token:   ${c.channel_token}`)
    if (c.status !== 'active') console.log(`  connect_url:     ${c.connect_url}`)
  }
} else if (cmd === 'create-channel' && arg) {
  const c = await coexy('POST', '/channels', { name: arg })
  console.log(`Canal criado. Abra para conectar o número:\n${c.connect_url}`)
} else if (cmd === 'webhook' && arg?.startsWith('https://')) {
  const w = await coexy('POST', '/webhooks', {
    name: 'WACRM',
    url: arg,
    events: ['messages', 'smb_message_echoes', 'message_template_status_update'],
  })
  console.log('Webhook criado. Guarde AGORA (não dá para recuperar depois):')
  console.log(`COEXY_HMAC_SECRET=${w.hmac_secret}`)
} else {
  console.log('Uso: node scripts/coexy-setup.mjs channels | create-channel "Nome" | webhook https://.../api/whatsapp/webhook')
  process.exit(1)
}
