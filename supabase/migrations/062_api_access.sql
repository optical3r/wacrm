-- ============================================================
-- 062 — Public API + MCP access controls (phase 1 of the API plan)
--
--   * api_keys.mcp_enabled / mcp_allow_writes: a key can be used by
--     the MCP server, which is read-only unless writes are switched on.
--   * accounts.api_enabled / api_rate_limit: the super admin turns the
--     API off per workspace and can override the per-minute limit
--     (NULL = the plan default).
--   * api_request_log: one row per API / MCP call, kept 30 days.
--   * api_rate_buckets + api_rate_hit(): a per-minute counter shared by
--     every server instance (the in-memory limiter was per instance).
-- ============================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS mcp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mcp_allow_writes BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS api_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS api_rate_limit INTEGER
    CHECK (api_rate_limit IS NULL OR api_rate_limit BETWEEN 1 AND 10000);

-- ------------------------------------------------------------
-- Request log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_request_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_id      UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  via         TEXT NOT NULL DEFAULT 'api' CHECK (via IN ('api', 'mcp')),
  method      TEXT NOT NULL,
  route       TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_log_account_idx
  ON api_request_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_log_created_idx
  ON api_request_log (created_at);

ALTER TABLE api_request_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_request_log_select ON api_request_log;
CREATE POLICY api_request_log_select ON api_request_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- Writes come only from the server (service role bypasses RLS).

-- ------------------------------------------------------------
-- Shared rate limiter
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_rate_buckets (
  bucket       TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE api_rate_buckets ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (and the function below) touch it.

CREATE OR REPLACE FUNCTION api_rate_hit(p_bucket TEXT, p_limit INTEGER, p_window_seconds INTEGER DEFAULT 60)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window TIMESTAMPTZ := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_hits INTEGER;
BEGIN
  INSERT INTO api_rate_buckets AS b (bucket, window_start, hits)
  VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = b.hits + 1
  RETURNING b.hits INTO v_hits;

  -- Old windows are useless after they close: trim now and then.
  IF random() < 0.01 THEN
    DELETE FROM api_rate_buckets WHERE window_start < now() - interval '1 hour';
  END IF;

  RETURN QUERY SELECT v_hits <= p_limit, GREATEST(p_limit - v_hits, 0), v_window + make_interval(secs => p_window_seconds);
END;
$$;
ALTER FUNCTION api_rate_hit(TEXT, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION api_rate_hit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api_rate_hit(TEXT, INTEGER, INTEGER) TO service_role;

-- 30-day retention for the request log, run nightly by pg_cron (053).
CREATE OR REPLACE FUNCTION prune_api_request_log()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM api_request_log WHERE created_at < now() - interval '30 days';
$$;
ALTER FUNCTION prune_api_request_log() OWNER TO postgres;
REVOKE ALL ON FUNCTION prune_api_request_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_api_request_log() TO service_role;

-- cron.schedule replaces a job that already has the same name.
SELECT cron.schedule('labcrm-api-log-prune', '17 3 * * *', $$SELECT public.prune_api_request_log()$$);
