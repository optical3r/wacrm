-- 057: leads with several owners, and a rotation for leads nobody owns.
--
--   * conversations.owner_ids: the attendants who "own" the lead. Any
--     number of them. assigned_agent_id stays as the first owner, so
--     everything that reads it keeps working.
--   * An owned lead is never reassigned by automations, flows, the AI
--     handoff or the rotation, not even after the chat is closed. Only
--     owner / admin change its owners; an agent may only take a lead
--     nobody owns, or leave one they own.
--   * lead_rotation: per account, on / off and the attendants it rotates
--     between. New leads with no owner go to the next one in turn (only
--     among those linked to the number the customer wrote to, when any
--     of them is).
--   * Every owner sees the chat (can_see_conversation) and gets the
--     assignment notification.
--
-- Idempotent — safe to run multiple times.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS conversations_owner_ids_idx ON conversations USING GIN (owner_ids);

UPDATE conversations
SET owner_ids = ARRAY[assigned_agent_id]
WHERE assigned_agent_id IS NOT NULL AND owner_ids = '{}';

-- ------------------------------------------------------------
-- Keep owner_ids and assigned_agent_id in step, and lock owned leads
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_conversation_owners()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old UUID[] := CASE WHEN TG_OP = 'UPDATE' THEN OLD.owner_ids ELSE '{}'::UUID[] END;
BEGIN
  NEW.owner_ids := COALESCE(NEW.owner_ids, '{}');

  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_ids = '{}' AND NEW.assigned_agent_id IS NOT NULL THEN
      NEW.owner_ids := ARRAY[NEW.assigned_agent_id];
    END IF;
  ELSIF NEW.owner_ids IS DISTINCT FROM OLD.owner_ids THEN
    -- Owners set explicitly: nothing more to work out.
    NULL;
  ELSIF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    -- Older code paths only write assigned_agent_id.
    IF NEW.assigned_agent_id IS NULL THEN
      -- "Unassign": the first owner steps out.
      NEW.owner_ids := array_remove(OLD.owner_ids, OLD.assigned_agent_id);
    ELSIF OLD.owner_ids = '{}' THEN
      NEW.owner_ids := ARRAY[NEW.assigned_agent_id];
    ELSIF NOT (NEW.assigned_agent_id = ANY(OLD.owner_ids)) THEN
      -- An owned lead is never reassigned this way.
      NEW.owner_ids := OLD.owner_ids;
    END IF;
  END IF;

  -- No duplicates, order kept.
  SELECT COALESCE(array_agg(u ORDER BY i), '{}') INTO NEW.owner_ids
  FROM (
    SELECT u, min(i) AS i
    FROM unnest(NEW.owner_ids) WITH ORDINALITY AS t(u, i)
    WHERE u IS NOT NULL
    GROUP BY u
  ) s;

  -- An agent (not owner / admin) may only take a free lead or leave one.
  IF TG_OP = 'UPDATE'
     AND auth.uid() IS NOT NULL
     AND NEW.owner_ids IS DISTINCT FROM v_old
     AND v_old <> '{}'
     AND NOT is_account_member(NEW.account_id, 'admin')
     AND NEW.owner_ids IS DISTINCT FROM array_remove(v_old, auth.uid()) THEN
    RAISE EXCEPTION 'Só o proprietário e os administradores mudam os donos de um lead.'
      USING ERRCODE = '42501', HINT = 'lead_owner_locked';
  END IF;

  NEW.assigned_agent_id := CASE
    WHEN NEW.owner_ids = '{}' THEN NULL
    WHEN NEW.assigned_agent_id = ANY(NEW.owner_ids) AND NOT (NEW.owner_ids IS DISTINCT FROM v_old) THEN NEW.assigned_agent_id
    ELSE NEW.owner_ids[1]
  END;
  RETURN NEW;
END;
$$;
ALTER FUNCTION sync_conversation_owners() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_conversation_owners ON conversations;
CREATE TRIGGER sync_conversation_owners
  BEFORE INSERT OR UPDATE OF assigned_agent_id, owner_ids ON conversations
  FOR EACH ROW EXECUTE FUNCTION sync_conversation_owners();

-- ------------------------------------------------------------
-- Notify every new owner (replaces the single-assignee version of 027)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
  v_new UUID[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := COALESCE(NEW.owner_ids, '{}');
  ELSE
    SELECT COALESCE(array_agg(u), '{}') INTO v_new
    FROM unnest(COALESCE(NEW.owner_ids, '{}')) AS u
    WHERE NOT (u = ANY(COALESCE(OLD.owner_ids, '{}')));
  END IF;
  IF auth.uid() IS NOT NULL THEN
    v_new := array_remove(v_new, auth.uid());
  END IF;
  IF v_new = '{}' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  )
  SELECT
    NEW.account_id, u, 'conversation_assigned', NEW.id, NEW.contact_id, auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  FROM unnest(v_new) AS u;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_assigned ON conversations;
CREATE TRIGGER on_conversation_assigned
  AFTER INSERT OR UPDATE OF assigned_agent_id, owner_ids ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_conversation_assigned();

-- ------------------------------------------------------------
-- Visibility: every owner sees the chat
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_see_conversation(
  target_account_id UUID,
  owners UUID[],
  conversation_channels UUID[]
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id)
    AND (
      NOT is_restricted_agent(target_account_id)
      OR auth.uid() = ANY(COALESCE(owners, '{}'))
      OR EXISTS (
        SELECT 1 FROM whatsapp_channel_members m
        WHERE m.account_id = target_account_id
          AND m.user_id = auth.uid()
          AND m.channel_id = ANY(conversation_channels)
      )
    );
$$;
ALTER FUNCTION can_see_conversation(UUID, UUID[], UUID[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_see_conversation(UUID, UUID[], UUID[]) TO authenticated, service_role;

DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_see_conversation(account_id, owner_ids, channel_ids));
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_see_conversation(account_id, owner_ids, channel_ids))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_see_conversation(account_id, owner_ids, channel_ids));

DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_see_conversation(c.account_id, c.owner_ids, c.channel_ids)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_see_conversation(c.account_id, c.owner_ids, c.channel_ids)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_see_conversation(c.account_id, c.owner_ids, c.channel_ids)
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_see_conversation(c.account_id, c.owner_ids, c.channel_ids)
  )
);

CREATE OR REPLACE FUNCTION can_see_contact(target_account_id UUID, target_contact_id UUID, creator UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id)
    AND (
      NOT is_restricted_agent(target_account_id)
      OR creator = auth.uid()
      OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = target_contact_id)
      OR EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.contact_id = target_contact_id
          AND c.account_id = target_account_id
          AND can_see_conversation(c.account_id, c.owner_ids, c.channel_ids)
      )
    );
$$;
ALTER FUNCTION can_see_contact(UUID, UUID, UUID) OWNER TO postgres;

-- The 3-argument version with a single assignee is no longer used.
DROP FUNCTION IF EXISTS can_see_conversation(UUID, UUID, UUID[]);

-- ------------------------------------------------------------
-- A member leaves: they stop owning the account's leads
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION remove_lead_owner(p_account_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET owner_ids = array_remove(owner_ids, p_user_id)
  WHERE account_id = p_account_id AND p_user_id = ANY(owner_ids);
$$;
ALTER FUNCTION remove_lead_owner(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION remove_lead_owner(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION remove_lead_owner(UUID, UUID) TO service_role;

-- ------------------------------------------------------------
-- Rotation for leads nobody owns
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_rotation (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  member_ids UUID[] NOT NULL DEFAULT '{}',
  last_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lead_rotation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_rotation_select ON lead_rotation;
DROP POLICY IF EXISTS lead_rotation_write ON lead_rotation;
CREATE POLICY lead_rotation_select ON lead_rotation FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY lead_rotation_write ON lead_rotation FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Give a lead nobody owns to the next attendant in the rotation. Among
-- `candidates` (the number's linked attendants) when any of them is in
-- the rotation, else among all of it. Returns who got it, or NULL (off,
-- nobody eligible, or the lead already has an owner).
CREATE OR REPLACE FUNCTION assign_lead_by_rotation(p_conversation_id UUID, p_candidates UUID[] DEFAULT '{}')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_rot lead_rotation%ROWTYPE;
  v_pool UUID[];
  v_narrow UUID[];
  v_pos INT;
  v_next UUID;
BEGIN
  SELECT account_id INTO v_account FROM conversations
  WHERE id = p_conversation_id AND owner_ids = '{}';
  IF v_account IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_rot FROM lead_rotation WHERE account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT v_rot.enabled THEN RETURN NULL; END IF;

  -- Rotation members still able to answer, in rotation order.
  SELECT COALESCE(array_agg(r.u ORDER BY r.i), '{}') INTO v_pool
  FROM unnest(v_rot.member_ids) WITH ORDINALITY AS r(u, i)
  WHERE EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = r.u AND p.account_id = v_account
      AND p.account_role IN ('owner', 'admin', 'agent')
  );
  IF v_pool = '{}' THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(u ORDER BY i), '{}') INTO v_narrow
  FROM unnest(v_pool) WITH ORDINALITY AS t(u, i)
  WHERE u = ANY(COALESCE(p_candidates, '{}'));
  IF v_narrow <> '{}' THEN v_pool := v_narrow; END IF;

  -- The one after the last picked, by rotation order.
  v_pos := array_position(v_rot.member_ids, v_rot.last_user_id);
  SELECT u INTO v_next
  FROM unnest(v_pool) AS u
  ORDER BY (array_position(v_rot.member_ids, u) <= COALESCE(v_pos, 0)), array_position(v_rot.member_ids, u)
  LIMIT 1;

  UPDATE conversations SET owner_ids = ARRAY[v_next]
  WHERE id = p_conversation_id AND owner_ids = '{}';
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE lead_rotation SET last_user_id = v_next, updated_at = now() WHERE account_id = v_account;
  RETURN v_next;
END;
$$;
ALTER FUNCTION assign_lead_by_rotation(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION assign_lead_by_rotation(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION assign_lead_by_rotation(UUID, UUID[]) TO service_role;
