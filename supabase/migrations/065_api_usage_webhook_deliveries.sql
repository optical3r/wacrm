-- 065: what Configurações › API e MCP shows.
--
--   webhook_deliveries   one row per webhook delivery attempt (status,
--                        time, error), kept 14 days, so the webhooks
--                        screen can show the latest deliveries.
--   api_usage_summary()  calls and errors of the last N days per key /
--                        connected app, from api_request_log (062).
--
-- Only the server (service role) reads these: RLS is on with no
-- policies and the functions are revoked from the browser roles. The
-- dashboard routes filter by the caller's account.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  endpoint_id UUID NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  delivery_id TEXT,
  ok BOOLEAN NOT NULL,
  status_code INTEGER,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON public.webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx
  ON public.webhook_deliveries (created_at);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_deliveries FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.prune_webhook_deliveries()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.webhook_deliveries WHERE created_at < now() - interval '14 days';
$$;
REVOKE ALL ON FUNCTION public.prune_webhook_deliveries() FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('labcrm-webhook-deliveries-prune', '27 3 * * *', $$SELECT public.prune_webhook_deliveries()$$);

-- ---------- API usage --------------------------------------------------

CREATE INDEX IF NOT EXISTS api_request_log_account_status_idx
  ON public.api_request_log (account_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.api_usage_summary(p_account UUID, p_days INTEGER DEFAULT 30)
RETURNS TABLE (key_id UUID, oauth_grant_id UUID, via TEXT, calls BIGINT, errors BIGINT, last_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.key_id, l.oauth_grant_id, l.via,
         count(*) AS calls,
         count(*) FILTER (WHERE l.status >= 400) AS errors,
         max(l.created_at) AS last_at
    FROM public.api_request_log l
   WHERE l.account_id = p_account
     AND l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 30))
   GROUP BY l.key_id, l.oauth_grant_id, l.via;
$$;

REVOKE ALL ON FUNCTION public.api_usage_summary(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
