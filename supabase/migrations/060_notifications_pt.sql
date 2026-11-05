-- 060: assignment notifications in Portuguese.
--
-- The trigger wrote the notification title and body in English
-- ("New conversation assigned" / "Someone assigned you a conversation
-- with ..."). This rewrites the trigger with Brazilian Portuguese text
-- and translates the rows already stored. Safe to run more than once.

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
    'Nova conversa atribuída',
    CASE
      WHEN v_actor_name IS NULL OR v_actor_name = ''
        THEN 'Você recebeu uma conversa com ' || COALESCE(v_contact_name, 'um contato')
      ELSE v_actor_name || ' atribuiu a você uma conversa com ' || COALESCE(v_contact_name, 'um contato')
    END
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

-- Translate what is already stored.
UPDATE notifications
SET
  title = 'Nova conversa atribuída',
  body = CASE
    WHEN body LIKE 'Someone assigned you a conversation with %'
      THEN 'Você recebeu uma conversa com '
        || regexp_replace(substr(body, length('Someone assigned you a conversation with ') + 1), '^a contact$', 'um contato')
    WHEN body LIKE '% assigned you a conversation with %'
      THEN regexp_replace(
        regexp_replace(body, ' assigned you a conversation with ', ' atribuiu a você uma conversa com '),
        'com a contact$', 'com um contato')
    ELSE body
  END
WHERE type = 'conversation_assigned'
  AND title = 'New conversation assigned';
