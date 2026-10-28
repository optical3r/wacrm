-- 051: several WhatsApp numbers per Starter account (one per member).
--
-- Each row of whatsapp_config becomes a "channel": a number connected by
-- QR code (D-API), owned by one member. The customer still has a single
-- conversation per account; every message records the channel it went
-- through, and the conversation keeps the channels it has used.
--
--   whatsapp_config  — no longer UNIQUE(account_id); + label, owner_user_id,
--                      is_default. Pro keeps 1 number, Starter up to
--                      accounts.max_numbers (default 5).
--   dapi_sessions    — keyed by session_id; one session per member.
--   messages         — + channel_id.
--   conversations    — + last_channel_id (last number the customer used)
--                      and channel_ids (every number the chat went through).
--
-- Visibility (Starter only): a member with the `agent` role sees the
-- conversations assigned to them or that went through their own number,
-- and the contacts / deals behind those. Owner, admin and viewer keep
-- seeing the whole account. Enforced here, in RLS.

-- ------------------------------------------------------------
-- accounts.max_numbers
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS max_numbers INTEGER NOT NULL DEFAULT 5
    CHECK (max_numbers BETWEEN 1 AND 50);

-- Same guard as 048, now covering max_numbers too.
CREATE OR REPLACE FUNCTION protect_account_plan_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.max_numbers IS DISTINCT FROM OLD.max_numbers)
     AND coalesce(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'plan, status and number limit can only be changed by the platform owner'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- whatsapp_config → channels
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Every existing row is its account's only number.
UPDATE whatsapp_config SET owner_user_id = user_id WHERE owner_user_id IS NULL;
UPDATE whatsapp_config SET is_default = true
WHERE NOT is_default
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config o WHERE o.account_id = whatsapp_config.account_id AND o.is_default
  );

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default
  ON whatsapp_config(account_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_per_owner
  ON whatsapp_config(account_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Number limit: Pro = 1 (official API), Starter = accounts.max_numbers.
CREATE OR REPLACE FUNCTION enforce_whatsapp_number_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan TEXT;
  v_max INTEGER;
  v_count INTEGER;
BEGIN
  SELECT plan, max_numbers INTO v_plan, v_max FROM accounts WHERE id = NEW.account_id;
  IF v_plan IS DISTINCT FROM 'starter' THEN
    v_max := 1;
  END IF;
  SELECT count(*) INTO v_count FROM whatsapp_config WHERE account_id = NEW.account_id;
  IF v_count >= coalesce(v_max, 1) THEN
    RAISE EXCEPTION 'number limit reached (% of %)', v_count, coalesce(v_max, 1)
      USING ERRCODE = 'P0001', HINT = 'whatsapp_number_limit';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_whatsapp_number_limit ON whatsapp_config;
CREATE TRIGGER enforce_whatsapp_number_limit BEFORE INSERT ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION enforce_whatsapp_number_limit();

-- ------------------------------------------------------------
-- dapi_sessions: one per member
-- ------------------------------------------------------------
ALTER TABLE dapi_sessions DROP CONSTRAINT IF EXISTS dapi_sessions_pkey;
ALTER TABLE dapi_sessions ADD PRIMARY KEY (session_id);
ALTER TABLE dapi_sessions
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

UPDATE dapi_sessions d
SET owner_user_id = coalesce(
  d.created_by,
  (SELECT w.owner_user_id FROM whatsapp_config w WHERE w.account_id = d.account_id AND w.is_default),
  (SELECT a.owner_user_id FROM accounts a WHERE a.id = d.account_id)
)
WHERE d.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS dapi_sessions_account_idx ON dapi_sessions(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS dapi_sessions_one_per_owner
  ON dapi_sessions(account_id, owner_user_id);
CREATE INDEX IF NOT EXISTS dapi_sessions_token_idx ON dapi_sessions(webhook_token_hash);

-- ------------------------------------------------------------
-- messages.channel_id, conversations.last_channel_id / channel_ids
-- ------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_conversations_channel_ids ON conversations USING GIN (channel_ids);

-- History so far went through each account's only number.
UPDATE messages m
SET channel_id = w.id
FROM conversations c
JOIN whatsapp_config w ON w.account_id = c.account_id AND w.is_default
WHERE c.id = m.conversation_id AND m.channel_id IS NULL;

UPDATE conversations c
SET last_channel_id = w.id, channel_ids = ARRAY[w.id]
FROM whatsapp_config w
WHERE w.account_id = c.account_id AND w.is_default AND c.last_channel_id IS NULL;

-- Keep the conversation's channels in step with its messages.
CREATE OR REPLACE FUNCTION note_message_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE conversations
  SET channel_ids = CASE
        WHEN NEW.channel_id = ANY(channel_ids) THEN channel_ids
        ELSE array_append(channel_ids, NEW.channel_id)
      END,
      last_channel_id = CASE
        WHEN NEW.sender_type = 'customer' OR last_channel_id IS NULL THEN NEW.channel_id
        ELSE last_channel_id
      END
  WHERE id = NEW.conversation_id
    AND (
      NOT (NEW.channel_id = ANY(channel_ids))
      OR last_channel_id IS NULL
      OR (NEW.sender_type = 'customer' AND last_channel_id IS DISTINCT FROM NEW.channel_id)
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS note_message_channel ON messages;
CREATE TRIGGER note_message_channel AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION note_message_channel();

-- ------------------------------------------------------------
-- Visibility helpers
-- ------------------------------------------------------------

-- True when auth.uid() is an `agent` of a Starter account: the only case
-- where visibility narrows to the member's own conversations.
CREATE OR REPLACE FUNCTION is_restricted_agent(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.account_role = 'agent'
      AND a.plan = 'starter'
  );
$$;

CREATE OR REPLACE FUNCTION can_see_conversation(
  target_account_id UUID,
  assigned_agent UUID,
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
      OR assigned_agent = auth.uid()
      OR EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.account_id = target_account_id
          AND w.owner_user_id = auth.uid()
          AND w.id = ANY(conversation_channels)
      )
    );
$$;

-- A contact is visible when the member may see one of its conversations,
-- created it, or it has no conversation yet (the shared address book).
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
          AND can_see_conversation(c.account_id, c.assigned_agent_id, c.channel_ids)
      )
    );
$$;

ALTER FUNCTION is_restricted_agent(UUID) OWNER TO postgres;
ALTER FUNCTION can_see_conversation(UUID, UUID, UUID[]) OWNER TO postgres;
ALTER FUNCTION can_see_contact(UUID, UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_restricted_agent(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION can_see_conversation(UUID, UUID, UUID[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION can_see_contact(UUID, UUID, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Policies
-- ------------------------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_see_conversation(account_id, assigned_agent_id, channel_ids));
-- WITH CHECK only asks for the role, so an agent can hand a chat over to
-- someone else (it then leaves their list).
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_see_conversation(account_id, assigned_agent_id, channel_ids))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_see_conversation(account_id, assigned_agent_id, channel_ids));

DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_see_conversation(c.account_id, c.assigned_agent_id, c.channel_ids)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_see_conversation(c.account_id, c.assigned_agent_id, c.channel_ids)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_see_conversation(c.account_id, c.assigned_agent_id, c.channel_ids)
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_see_conversation(c.account_id, c.assigned_agent_id, c.channel_ids)
  )
);

DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_see_contact(account_id, id, user_id));
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_see_contact(account_id, id, user_id))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_see_contact(account_id, id, user_id));

DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals FOR SELECT USING (
  is_account_member(account_id)
  AND (
    NOT is_restricted_agent(account_id)
    OR assigned_to = auth.uid()
    OR user_id = auth.uid()
    OR (contact_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM contacts ct WHERE ct.id = deals.contact_id AND can_see_contact(ct.account_id, ct.id, ct.user_id)
    ))
  )
);
