-- 054: Flows step 3.
--
--   1. New 'create_deal' value on flow_nodes.node_type (the "Criar
--      negócio" block).
--   2. flow_funnel(flow_id): how many runs reached each node, and how
--      many runs ended in each status. Powers the funnel on the runs
--      page. SECURITY INVOKER, so the caller's RLS on flow_runs and
--      flow_run_events decides what is counted.
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
    'handoff',
    'http_fetch',
    'end'
  ));

CREATE OR REPLACE FUNCTION public.flow_funnel(p_flow_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'nodes', COALESCE((
      SELECT jsonb_object_agg(node_key, runs)
      FROM (
        SELECT e.node_key, COUNT(DISTINCT e.flow_run_id) AS runs
        FROM flow_run_events e
        JOIN flow_runs r ON r.id = e.flow_run_id
        WHERE r.flow_id = p_flow_id
          AND e.node_key IS NOT NULL
          AND e.event_type IN ('started', 'node_entered', 'message_sent', 'handoff', 'completed')
        GROUP BY e.node_key
      ) n
    ), '{}'::jsonb),
    'statuses', COALESCE((
      SELECT jsonb_object_agg(status, runs)
      FROM (
        SELECT status, COUNT(*) AS runs
        FROM flow_runs
        WHERE flow_id = p_flow_id
        GROUP BY status
      ) s
    ), '{}'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.flow_funnel(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.flow_funnel(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.flow_funnel(UUID) TO authenticated;
