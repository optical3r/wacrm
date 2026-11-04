-- 056: numbers belong to the company, shared by several attendants.
--
-- Before (051) each Starter number was owned by one member, who alone
-- connected it, saw its chats and answered through it. Now:
--
--   * only owner / admin connect, rename and remove numbers (the API
--     enforces it; whatsapp_config writes were already admin-only);
--   * whatsapp_channel_members links any number of attendants to each
--     number. A linked attendant sees the chats that went through the
--     number and answers through it;
--   * whatsapp_config.sign_messages: when on, messages sent from the
--     inbox start with the attendant's name.
--
-- whatsapp_config.owner_user_id stays as "who connected it" and no longer
-- grants anything. The one-number-per-member limits are dropped.
--
-- Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS whatsapp_channel_members (
  channel_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_channel_members_user_idx
  ON whatsapp_channel_members(user_id);

ALTER TABLE whatsapp_channel_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_channel_members_select ON whatsapp_channel_members;
DROP POLICY IF EXISTS whatsapp_channel_members_write ON whatsapp_channel_members;
CREATE POLICY whatsapp_channel_members_select ON whatsapp_channel_members FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_channel_members_write ON whatsapp_channel_members FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Today's owners become the first linked attendant of their number.
INSERT INTO whatsapp_channel_members (channel_id, user_id, account_id)
SELECT w.id, w.owner_user_id, w.account_id
FROM whatsapp_config w
JOIN profiles p ON p.user_id = w.owner_user_id AND p.account_id = w.account_id
WHERE w.owner_user_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS sign_messages BOOLEAN NOT NULL DEFAULT false;

-- Several numbers may now be connected by the same admin.
DROP INDEX IF EXISTS whatsapp_config_one_per_owner;
DROP INDEX IF EXISTS dapi_sessions_one_per_owner;

-- A D-API session points at the number it connects (null while a brand
-- new number is still being paired).
ALTER TABLE dapi_sessions
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE dapi_sessions d
SET channel_id = w.id
FROM whatsapp_config w
WHERE d.channel_id IS NULL AND w.phone_number_id = 'dapi:' || d.session_id;
CREATE INDEX IF NOT EXISTS dapi_sessions_channel_idx ON dapi_sessions(channel_id);

-- Visibility: a restricted agent sees chats assigned to them or that
-- went through a number they are linked to.
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
        SELECT 1 FROM whatsapp_channel_members m
        WHERE m.account_id = target_account_id
          AND m.user_id = auth.uid()
          AND m.channel_id = ANY(conversation_channels)
      )
    );
$$;
ALTER FUNCTION can_see_conversation(UUID, UUID, UUID[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_see_conversation(UUID, UUID, UUID[]) TO authenticated, service_role;
