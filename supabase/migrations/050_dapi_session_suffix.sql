-- 050: D-API session ids carry a per-pairing suffix
-- (`labcrm-<account_id>-<suffix>`), because D-API keeps the ids of
-- deleted sessions reserved. The guard from 049 now checks that the id
-- starts with the account's own prefix instead of matching it exactly.

CREATE OR REPLACE FUNCTION guard_dapi_phone_number_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_number_id ILIKE 'dapi:%'
     AND (TG_OP = 'INSERT' OR NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    IF coalesce(auth.role(), '') <> 'service_role'
       AND current_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'dapi connections can only be saved by the server'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.phone_number_id <> 'dapi:labcrm-' || NEW.account_id::text
       AND left(NEW.phone_number_id, length('dapi:labcrm-' || NEW.account_id::text || '-'))
           <> 'dapi:labcrm-' || NEW.account_id::text || '-' THEN
      RAISE EXCEPTION 'dapi session does not belong to this account'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
