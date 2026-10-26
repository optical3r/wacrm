# Coexy como API oficial

O Coexy é um relay transparente da WhatsApp Cloud API: mesmos endpoints,
mesmo body e mesmo payload de webhook da Meta. O wacrm usa o Coexy quando
`WHATSAPP_PROVIDER=coexy`, sem precisar de app no developers.facebook.com.

## O que muda no código

| Ponto | Meta direto | Coexy |
|---|---|---|
| Base URL (`src/lib/whatsapp/provider.ts`) | `graph.facebook.com/v21.0` | `api.coexy.com.br/functions/v1/meta-proxy` |
| "Access token" salvo em Configurações → WhatsApp | token da Meta | `channel_token` do canal |
| Assinatura do webhook | `x-hub-signature-256` + `META_APP_SECRET` | `x-coexy-signature` + `COEXY_HMAC_SECRET` |
| `/register` do número e `subscribed_apps` | feitos pelo wacrm | pulados (o Coexy faz na conexão) |

## Passo a passo

1. No `.env.local` (e na hospedagem):
   ```
   WHATSAPP_PROVIDER=coexy
   COEXY_API_KEY=crt_pk_...
   ```
2. Criar o canal e conectar o número (se ainda não existir):
   `node scripts/coexy-setup.mjs create-channel "Cerqueira Labs"` e abrir o `connect_url`.
3. Pegar os dados do canal: `node scripts/coexy-setup.mjs channels`.
4. Em Configurações → WhatsApp: `phone_number_id`, `waba_id` e o
   `channel_token` no campo de access token. PIN e verify token não são usados.
5. Registrar o webhook (precisa de URL pública HTTPS):
   `node scripts/coexy-setup.mjs webhook https://SEU-DOMINIO/api/whatsapp/webhook`
   e colocar o `hmac_secret` impresso em `COEXY_HMAC_SECRET`. Ele só aparece uma vez.
6. Reiniciar o app e mandar uma mensagem de teste para o número.

## Pontos de atenção

- Texto livre só dentro da janela de 24 h; fora dela, use template (erro 131047).
- Erro `CHANNEL_DISCONNECTED` (503): não recrie o canal, reconecte pelo `connect_url`.
- Limite do proxy: 100 requisições por minuto por canal.
- A spec completa está em `coexy-spec.md`, na raiz do projeto.
