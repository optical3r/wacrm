# Coexy — especificação de integração (resumo fiel)

Fonte: spec enviada pelo Rodrigo em 2026-10-26. O Coexy NÃO tem API própria de
envio: é um relay da WhatsApp Cloud API. Para corpo de mensagens e payloads,
use a documentação da Meta (developers.facebook.com/docs/whatsapp/cloud-api).

## Credenciais

| Credencial | Onde achar | Uso |
|---|---|---|
| `COEXY_API_KEY` (`crt_pk_...`) | Painel → Configurações → API Keys | Management API, header `x-api-key` |
| `channel_token` | Painel → Canais → aba API, ou `GET /api/channels` | Meta proxy, `Authorization: Bearer` |
| `phone_number_id`, `waba_id` | idem (só depois de conectar o número) | path do meta-proxy |
| `COEXY_HMAC_SECRET` | resposta da criação do webhook (só uma vez) | verificar eventos recebidos |

Nunca usar essas credenciais no frontend. Não confundir API key com channel_token.

## URLs

- Base: `https://api.coexy.com.br/functions/v1`
- Management API: `/api` (header `x-api-key`)
- Meta proxy: `/meta-proxy` (header `Authorization: Bearer <channel_token>`)

## Management API

- Canais: `GET/POST /channels`, `GET/DELETE /channels/:id` (`POST` com `{ "name" }`, retorna 201).
  Campos: `id, name, status (pending|active|disconnected|suspended), display_phone_number,
  phone_number_id, waba_id, channel_token, connect_url, connected_at, created_at, verification{status,attempts,max_attempts,rejection_reasons,verified_at,url}`.
  Deletar canal ativo exige `?force=true` (senão 409).
- Conectar número: o dono abre `connect_url` (Embedded Signup da Meta); o canal vira `active`.
  Tokens da Meta são renovados pelo Coexy.
- Webhooks: `POST /webhooks` `{ name, url (https), events?, channel_ids? }` → retorna `hmac_secret` (só uma vez).
  `PATCH /webhooks/:id` (`status: active|paused`, `events`, `url`, `name`), `DELETE /webhooks/:id`,
  `POST|DELETE /webhooks/:wid/channels/:cid`.
  Eventos: messages, smb_message_echoes, message_echoes, message_template_status_update,
  message_template_quality_update, phone_number_quality_update, phone_number_name_update,
  account_alerts, account_update, account_review_update, flows, security.
- Erros: 401 (header ausente / chave inválida / expirada), 429 com `Retry-After`, 404, 409, 422.

## Meta proxy

Troca mecânica: `https://graph.facebook.com/v23.0/` → `https://api.coexy.com.br/functions/v1/meta-proxy/`
e o Bearer passa a ser o `channel_token`. Todo o resto igual à Meta.

- Enviar: `POST /meta-proxy/{phone_number_id}/messages`
- Templates: `GET /meta-proxy/{waba_id}/message_templates?fields=...`
- Idempotência: campo `idempotency_key` no body (o Coexy remove antes de repassar e devolve o wamid original em repetição).
- Erros: 401 `Authorization header required` / `Invalid channel token`; 403 `Channel is not active`;
  429 (100 req/min por canal); 503 `CHANNEL_DISCONNECTED` → reconectar via `connect_url`, não recriar o canal.

## Webhook recebido

- Headers: `X-Coexy-Signature: sha256=<hex>`, `User-Agent: Coexy-Webhooks/1.0`.
- HMAC-SHA256 do body cru com `COEXY_HMAC_SECRET`, comparação em tempo constante; inválido → 401.
- Responder 200 em até 10 s e processar depois. Retentativas: imediata, 30 s, 2 min, 10 min.
- Pode chegar duplicado: usar o `wamid` como chave de idempotência.
- Payload: formato nativo da Meta (`object`, `entry[].changes[].value.messages[] / statuses[]`).
