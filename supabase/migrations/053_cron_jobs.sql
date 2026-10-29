-- 053: schedule the Flows and Automations sweeps from the database.
--
-- /api/flows/cron times out abandoned flow runs (without it a contact
-- who leaves a flow halfway stays in it forever and no other flow can
-- start for them). /api/automations/cron resumes "wait" steps and
-- expires replies nobody answered. Both need a scheduler; Vercel's free
-- plan only allows one run a day, so pg_cron calls them every 5
-- minutes through pg_net instead.
--
-- The shared secret (AUTOMATION_CRON_SECRET in Vercel) is read from
-- Supabase Vault at run time, under the name 'labcrm_cron_secret'. It
-- is created once, separately, so it never lives in a migration file:
--
--   select vault.create_secret('<the secret>', 'labcrm_cron_secret');
--
-- Idempotent — safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.labcrm_call_cron(p_path TEXT)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT net.http_get(
    url := 'https://crm.cerqueiralabs.com.br' || p_path,
    headers := jsonb_build_object(
      'x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'labcrm_cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 30000
  );
$$;

REVOKE ALL ON FUNCTION public.labcrm_call_cron(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.labcrm_call_cron(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.labcrm_call_cron(TEXT) FROM authenticated;

-- cron.schedule replaces a job that already has the same name.
SELECT cron.schedule('labcrm-flows-sweep', '*/5 * * * *', $$SELECT public.labcrm_call_cron('/api/flows/cron')$$);
SELECT cron.schedule('labcrm-automations-sweep', '*/5 * * * *', $$SELECT public.labcrm_call_cron('/api/automations/cron')$$);
