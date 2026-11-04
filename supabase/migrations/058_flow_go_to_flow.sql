-- 058: Flows step 5. New 'go_to_flow' value on flow_nodes.node_type
-- ("Ir para outro fluxo" block): the run ends and the contact carries on
-- at the start of another active flow of the account, with the same
-- answers (vars). The target lives in flow_nodes.config.flow_id.
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
    'go_to_flow',
    'end'
  ));
