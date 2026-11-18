-- 063: webhook events raised by the database.
--
-- Deals, tags, lead owners and flow runs are written from many places
-- (the dashboard writes deals straight from the browser, flows and
-- automations from the server, and now the API and the MCP). So their
-- webhook events come from table triggers instead of from app code:
--
--   trigger → public.labcrm_emit_event(account, event, data)
--           → (only if the account has an active endpoint subscribed
--              to that event) pg_net POST /api/webhooks/emit
--           → the app signs and delivers it like every other event.
--
-- pg_net sends after the transaction commits, so a rolled-back write
-- never emits. The x-cron-secret header reuses the Vault secret
-- 'labcrm_cron_secret' from migration 053 (AUTOMATION_CRON_SECRET in
-- Vercel). Any failure here only raises a WARNING: an event can be
-- lost, but a write is never blocked by it.
--
-- Events: contact.created, contact.deleted, contact.tag_added,
-- contact.tag_removed, deal.created, deal.stage_changed,
-- deal.status_changed, deal.deleted, conversation.status_changed,
-- conversation.owners_changed, flow.started, flow.ended.
--
-- Idempotent: safe to run more than once.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.labcrm_emit_event(p_account UUID, p_event TEXT, p_data JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_account IS NULL THEN
    RETURN;
  END IF;
  -- Most accounts have no endpoint: skip the HTTP call entirely.
  IF NOT EXISTS (
    SELECT 1 FROM public.webhook_endpoints
    WHERE account_id = p_account AND is_active AND p_event = ANY (events)
  ) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://crm.cerqueiralabs.com.br/api/webhooks/emit',
    body := jsonb_build_object('account_id', p_account, 'event', p_event, 'data', p_data),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'labcrm_cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 10000
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'labcrm_emit_event(%): %', p_event, SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.labcrm_emit_event(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.labcrm_emit_event(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.labcrm_emit_event(UUID, TEXT, JSONB) FROM authenticated;

-- ---------- contacts ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.labcrm_emit_contact_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.contacts;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF coalesce(r.is_group, false) THEN
    RETURN NULL;
  END IF;
  PERFORM public.labcrm_emit_event(
    r.account_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'contact.deleted' ELSE 'contact.created' END,
    jsonb_build_object('contact_id', r.id, 'name', r.name, 'phone', r.phone, 'email', r.email, 'company', r.company)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS labcrm_webhook_contact ON public.contacts;
CREATE TRIGGER labcrm_webhook_contact
  AFTER INSERT OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.labcrm_emit_contact_event();

-- ---------- contact tags ------------------------------------------------

CREATE OR REPLACE FUNCTION public.labcrm_emit_contact_tag_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.contact_tags;
  v_account UUID;
  v_tag TEXT;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- When the contact itself is being deleted it is already gone here,
  -- so no tag_removed noise follows a contact.deleted.
  SELECT account_id INTO v_account FROM public.contacts WHERE id = r.contact_id AND NOT coalesce(is_group, false);
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT name INTO v_tag FROM public.tags WHERE id = r.tag_id;
  PERFORM public.labcrm_emit_event(
    v_account,
    CASE WHEN TG_OP = 'DELETE' THEN 'contact.tag_removed' ELSE 'contact.tag_added' END,
    jsonb_build_object('contact_id', r.contact_id, 'tag_id', r.tag_id, 'tag_name', v_tag)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS labcrm_webhook_contact_tag ON public.contact_tags;
CREATE TRIGGER labcrm_webhook_contact_tag
  AFTER INSERT OR DELETE ON public.contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.labcrm_emit_contact_tag_event();

-- ---------- deals -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.labcrm_deal_json(d public.deals)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'deal_id', d.id,
    'title', d.title,
    'value', d.value,
    'currency', d.currency,
    'status', d.status,
    'pipeline_id', d.pipeline_id,
    'stage_id', d.stage_id,
    'stage_name', (SELECT name FROM public.pipeline_stages WHERE id = d.stage_id),
    'contact_id', d.contact_id,
    'conversation_id', d.conversation_id,
    'assigned_to', d.assigned_to
  );
$$;

REVOKE ALL ON FUNCTION public.labcrm_deal_json(public.deals) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.labcrm_deal_json(public.deals) FROM anon;
REVOKE ALL ON FUNCTION public.labcrm_deal_json(public.deals) FROM authenticated;

CREATE OR REPLACE FUNCTION public.labcrm_emit_deal_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.labcrm_emit_event(NEW.account_id, 'deal.created', public.labcrm_deal_json(NEW));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.labcrm_emit_event(
      OLD.account_id, 'deal.deleted',
      jsonb_build_object('deal_id', OLD.id, 'title', OLD.title, 'pipeline_id', OLD.pipeline_id, 'contact_id', OLD.contact_id)
    );
  ELSE
    IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      PERFORM public.labcrm_emit_event(
        NEW.account_id, 'deal.stage_changed',
        public.labcrm_deal_json(NEW) || jsonb_build_object(
          'previous_stage_id', OLD.stage_id,
          'previous_pipeline_id', OLD.pipeline_id
        )
      );
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.labcrm_emit_event(
        NEW.account_id, 'deal.status_changed',
        public.labcrm_deal_json(NEW) || jsonb_build_object('previous_status', OLD.status)
      );
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS labcrm_webhook_deal ON public.deals;
CREATE TRIGGER labcrm_webhook_deal
  AFTER INSERT OR UPDATE OF stage_id, status OR DELETE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.labcrm_emit_deal_event();

-- ---------- conversations (status, lead owners) -------------------------

CREATE OR REPLACE FUNCTION public.labcrm_emit_conversation_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(NEW.is_group, false) THEN
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.labcrm_emit_event(
      NEW.account_id, 'conversation.status_changed',
      jsonb_build_object(
        'conversation_id', NEW.id, 'contact_id', NEW.contact_id,
        'status', NEW.status, 'previous_status', OLD.status
      )
    );
  END IF;
  IF coalesce(NEW.owner_ids, '{}') IS DISTINCT FROM coalesce(OLD.owner_ids, '{}') THEN
    PERFORM public.labcrm_emit_event(
      NEW.account_id, 'conversation.owners_changed',
      jsonb_build_object(
        'conversation_id', NEW.id, 'contact_id', NEW.contact_id,
        'owner_ids', to_jsonb(coalesce(NEW.owner_ids, '{}')),
        'previous_owner_ids', to_jsonb(coalesce(OLD.owner_ids, '{}'))
      )
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS labcrm_webhook_conversation ON public.conversations;
CREATE TRIGGER labcrm_webhook_conversation
  AFTER UPDATE OF status, owner_ids ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.labcrm_emit_conversation_event();

-- ---------- flow runs ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.labcrm_emit_flow_run_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT name INTO v_name FROM public.flows WHERE id = NEW.flow_id;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.labcrm_emit_event(
      NEW.account_id, 'flow.started',
      jsonb_build_object(
        'flow_run_id', NEW.id, 'flow_id', NEW.flow_id, 'flow_name', v_name,
        'contact_id', NEW.contact_id, 'conversation_id', NEW.conversation_id
      )
    );
  ELSIF OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active' THEN
    PERFORM public.labcrm_emit_event(
      NEW.account_id, 'flow.ended',
      jsonb_build_object(
        'flow_run_id', NEW.id, 'flow_id', NEW.flow_id, 'flow_name', v_name,
        'contact_id', NEW.contact_id, 'conversation_id', NEW.conversation_id,
        'status', NEW.status, 'end_reason', NEW.end_reason
      )
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS labcrm_webhook_flow_run ON public.flow_runs;
CREATE TRIGGER labcrm_webhook_flow_run
  AFTER INSERT OR UPDATE OF status ON public.flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.labcrm_emit_flow_run_event();

-- The trigger functions only run as triggers.
REVOKE ALL ON FUNCTION public.labcrm_emit_contact_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.labcrm_emit_contact_tag_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.labcrm_emit_deal_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.labcrm_emit_conversation_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.labcrm_emit_flow_run_event() FROM PUBLIC, anon, authenticated;
