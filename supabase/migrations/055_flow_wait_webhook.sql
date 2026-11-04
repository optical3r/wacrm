-- 055: Flows step 4.
--
--   1. New 'wait' value on flow_nodes.node_type ("Esperar" block).
--      'http_fetch' ("Webhook") was already allowed.
--   2. flow_runs.resume_at: when a run parked on a wait node carries on.
--      /api/flows/cron (every 5 minutes, migration 053) resumes the runs
--      whose time has come.
--
-- "Flow per number" needs no column: the numbers live in
-- flows.trigger_config.channel_ids.
--
-- Idempotent — safe to run multiple times.

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'create_deal',
    'wait',
    'handoff',
    'http_fetch',
    'end'
  ));

ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_flow_runs_resume_at
  ON flow_runs(resume_at)
  WHERE status = 'active' AND resume_at IS NOT NULL;
