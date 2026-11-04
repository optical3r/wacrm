-- 059: Flows step 6. New 'router' value on flow_nodes.node_type
-- ("Vários caminhos" block): ordered routes, each with its own rules
-- (all / any), the first that holds wins, else a default path. Rules
-- also gain number comparisons (gt, gte, lt, lte) and the condition
-- node can combine several rules; both live in flow_nodes.config.
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
    'router',
    'set_tag',
    'create_deal',
    'wait',
    'handoff',
    'http_fetch',
    'go_to_flow',
    'end'
  ));
