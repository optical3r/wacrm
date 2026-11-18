-- 064: OAuth for the remote MCP (claude.ai custom connectors).
--
-- claude.ai (site and phone app) cannot take a pasted API key: it logs
-- in with OAuth 2.1. LabCRM becomes the authorization server for its
-- own MCP at /api/mcp:
--
--   oauth_clients  apps that registered themselves (dynamic client
--                  registration) or were read from a client metadata
--                  document. Secrets only as SHA-256 hashes.
--   oauth_codes    one-time authorization codes (PKCE S256), 10 min.
--   oauth_grants   one row per "app conectado": a person allowed an
--                  app on one workspace, read-only or read and write.
--                  Holds the current access and refresh token hashes
--                  (rotated on every refresh). Revoking it in
--                  Configurações cuts the app off at once.
--
-- Only the server (service role) touches these tables: RLS is on with
-- no policies, so the browser can never read them.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  -- 'dcr' = registered through /api/oauth/register; 'cimd' = client_id
  -- is the https URL of its metadata document.
  source TEXT NOT NULL DEFAULT 'dcr' CHECK (source IN ('dcr', 'cimd')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  allow_writes BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.oauth_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  allow_writes BOOLEAN NOT NULL DEFAULT false,
  resource TEXT,
  access_hash TEXT UNIQUE,
  access_expires_at TIMESTAMPTZ,
  refresh_hash TEXT UNIQUE,
  refresh_expires_at TIMESTAMPTZ,
  -- The refresh token this one replaced: presenting it again means it
  -- leaked, and the whole grant is revoked.
  previous_refresh_hash TEXT,
  -- The authorization code this grant came from: a second try with the
  -- same code revokes the grant (RFC 6749 §4.1.2).
  origin_code_hash TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_grants_account_idx ON public.oauth_grants (account_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_previous_refresh_idx ON public.oauth_grants (previous_refresh_hash);
CREATE INDEX IF NOT EXISTS oauth_grants_origin_code_idx ON public.oauth_grants (origin_code_hash);
CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON public.oauth_codes (expires_at);

-- Usage per connected app (Configurações › API e MCP).
ALTER TABLE public.api_request_log
  ADD COLUMN IF NOT EXISTS oauth_grant_id UUID REFERENCES public.oauth_grants(id) ON DELETE SET NULL;

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_grants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.oauth_clients FROM anon, authenticated;
REVOKE ALL ON public.oauth_codes FROM anon, authenticated;
REVOKE ALL ON public.oauth_grants FROM anon, authenticated;

-- Housekeeping, daily: drop expired codes, long-dead grants, and
-- self-registered apps that never got connected within 30 days.
CREATE OR REPLACE FUNCTION public.labcrm_oauth_cleanup()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.oauth_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM public.oauth_grants
   WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
      OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < now() - interval '30 days');
  DELETE FROM public.oauth_clients c
   WHERE c.created_at < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM public.oauth_grants g WHERE g.client_id = c.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.oauth_codes o WHERE o.client_id = c.client_id);
$$;

REVOKE ALL ON FUNCTION public.labcrm_oauth_cleanup() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('labcrm-oauth-cleanup', '17 4 * * *', $$SELECT public.labcrm_oauth_cleanup()$$);
