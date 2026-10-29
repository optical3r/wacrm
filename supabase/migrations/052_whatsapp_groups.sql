-- 052: WhatsApp groups on the Starter plan (D-API numbers only).
--
-- A group is stored as a contact flagged is_group, keyed by its WhatsApp
-- id (wa_group_id, "<digits>@g.us"), with one conversation per account
-- like any other contact. A message in a group is stored once, even when
-- several of the account's numbers are in that group; the conversation's
-- channel_ids (migration 051) lists every number that is in it, which is
-- what decides who sees the group and which numbers can write to it.
--
--   whatsapp_config — + read_groups: owner / admin switch group reading
--                     on per number (off by default).
--   contacts        — + is_group, wa_group_id, group_hidden_at (a hidden
--                     group's messages are no longer stored).
--   conversations   — + is_group (the inbox's Groups tab).
--   messages        — + sender_wa_id, sender_name: who wrote it in the
--                     group (WhatsApp often hides the phone: then only
--                     the name and an opaque id are known).
--
-- Groups never run flows, automations, AI replies or broadcasts, and are
-- not listed as contacts; the app enforces that.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS read_groups BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wa_group_id TEXT,
  ADD COLUMN IF NOT EXISTS group_hidden_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_group_id
  ON contacts (account_id, wa_group_id)
  WHERE wa_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_account_is_group
  ON contacts (account_id)
  WHERE is_group;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_conversations_account_is_group
  ON conversations (account_id, is_group);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_wa_id TEXT,
  ADD COLUMN IF NOT EXISTS sender_name TEXT;

-- A group message that reaches a second number of the account is a
-- duplicate (same WhatsApp id) and is not inserted again, so the
-- note_message_channel trigger (051) never sees that number. The webhook
-- records it with this instead.
CREATE OR REPLACE FUNCTION public.note_conversation_channel(
  p_conversation_id UUID,
  p_channel_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET channel_ids = array_append(coalesce(channel_ids, '{}'), p_channel_id)
  WHERE id = p_conversation_id
    AND NOT (coalesce(channel_ids, '{}') @> ARRAY[p_channel_id]);
$$;

ALTER FUNCTION public.note_conversation_channel(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.note_conversation_channel(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.note_conversation_channel(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.note_conversation_channel(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.note_conversation_channel(UUID, UUID) TO service_role;
