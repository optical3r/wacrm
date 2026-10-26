-- 049: Starter plan WhatsApp connection by QR code, through D-API.
--
-- One D-API session per organization. The session's webhook URL carries
-- a random per-account token; only its SHA-256 is stored here, and the
-- webhook route compares hashes before trusting a payload.
--
-- dapi_webhook_log keeps the raw payloads for a few days so the
-- translation into Meta's webhook shape can be checked against what
-- D-API really sends. Both tables are service role only.

CREATE TABLE IF NOT EXISTS dapi_sessions (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  webhook_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connecting',
  phone TEXT,
  risk_accepted_at TIMESTAMPTZ,
  risk_accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dapi_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS dapi_webhook_log (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  event TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dapi_webhook_log_created_idx ON dapi_webhook_log(created_at);
ALTER TABLE dapi_webhook_log ENABLE ROW LEVEL SECURITY;

-- `dapi:<sessionId>` phone_number_ids route sends through a D-API
-- session (see src/lib/whatsapp/dapi.ts). Only the service role may
-- write one, and only the account's own session id, so no tenant can
-- point its connection at another organization's WhatsApp.
CREATE OR REPLACE FUNCTION guard_dapi_phone_number_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_number_id ILIKE 'dapi:%'
     AND (TG_OP = 'INSERT' OR NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    IF coalesce(auth.role(), '') <> 'service_role'
       AND current_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'dapi connections can only be saved by the server'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.phone_number_id <> 'dapi:labcrm-' || NEW.account_id::text THEN
      RAISE EXCEPTION 'dapi session does not belong to this account'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_dapi_phone_number_id ON whatsapp_config;
CREATE TRIGGER guard_dapi_phone_number_id BEFORE INSERT OR UPDATE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION guard_dapi_phone_number_id();
