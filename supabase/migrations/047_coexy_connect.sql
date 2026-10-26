-- 047: one-click WhatsApp connection through Coexy (WHATSAPP_PROVIDER=coexy).
--
-- coexy_channels: the Coexy channel each account created with the
-- "Conectar" button. Kept apart from whatsapp_config because a channel
-- exists (pending) before the number is connected, while whatsapp_config
-- needs phone_number_id / access_token from the start.
--
-- coexy_webhooks: the org-wide Coexy webhook pointing at
-- /api/whatsapp/webhook, created automatically on the first connect.
-- Coexy shows its hmac_secret only once, so it is stored here encrypted
-- (ENCRYPTION_KEY) and used to verify X-Coexy-Signature.
--
-- Both tables are server-only: RLS on, no policies, service role only.

CREATE TABLE IF NOT EXISTS coexy_channels (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE coexy_channels ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coexy_webhooks (
  webhook_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE coexy_webhooks ENABLE ROW LEVEL SECURITY;
