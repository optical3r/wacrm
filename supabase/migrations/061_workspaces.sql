-- ============================================================
-- 061_workspaces.sql — several workspaces per client
--
-- A workspace is an account, exactly as before: chats, contacts,
-- numbers, pipelines, flows and settings stay isolated per account
-- and every RLS policy is unchanged.
--
-- What is new:
--   organizations       — the client (e.g. "Optical") that groups its
--                         workspaces; max_workspaces is set in /admin.
--   accounts.organization_id
--   account_memberships — every workspace a user belongs to, with the
--                         role in each one.
--   profiles.account_id / account_role now mean "the active
--   workspace" and the role there. RLS keeps reading them, so a user
--   only ever sees the workspace they switched to.
--
-- RPCs: list_my_workspaces, switch_workspace, create_workspace.
-- Member RPCs (set role, remove, transfer, redeem invitation) now
-- work on memberships, and a user can join a second workspace.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- Organizations (clients)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  max_workspaces INTEGER NOT NULL DEFAULT 1 CHECK (max_workspaces BETWEEN 1 AND 50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organizations_owner_idx ON organizations(owner_user_id);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS accounts_organization_idx ON accounts(organization_id);

-- Every existing account becomes the first workspace of its own client.
DO $$
DECLARE
  r RECORD;
  v_org UUID;
BEGIN
  FOR r IN SELECT id, name, owner_user_id FROM accounts WHERE organization_id IS NULL LOOP
    INSERT INTO organizations (name, owner_user_id)
    VALUES (r.name, r.owner_user_id)
    RETURNING id INTO v_org;
    UPDATE accounts SET organization_id = v_org WHERE id = r.id;
  END LOOP;
END $$;

-- An owner may now own several accounts (one per workspace).
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

-- ------------------------------------------------------------
-- Memberships
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_memberships (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS account_memberships_user_idx ON account_memberships(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_memberships_one_owner
  ON account_memberships(account_id) WHERE role = 'owner';
ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;

INSERT INTO account_memberships (account_id, user_id, role)
SELECT account_id, user_id, account_role
FROM profiles
WHERE account_id IS NOT NULL AND account_role IS NOT NULL
ON CONFLICT (account_id, user_id) DO NOTHING;

-- Members of the active workspace see its memberships; everyone sees
-- their own. Writes only go through the RPCs below.
DROP POLICY IF EXISTS account_memberships_select ON account_memberships;
CREATE POLICY account_memberships_select ON account_memberships FOR SELECT
  USING (user_id = auth.uid() OR is_account_member(account_id));

DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM accounts a
      JOIN account_memberships m ON m.account_id = a.id
      WHERE a.organization_id = organizations.id AND m.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- Profiles: a teammate is visible when they belong to the caller's
-- active workspace, even if their own active workspace is another.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION shares_active_workspace(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_memberships m
    JOIN profiles me ON me.user_id = auth.uid() AND me.account_id = m.account_id
    JOIN accounts a ON a.id = m.account_id AND a.status = 'active'
    WHERE m.user_id = target_user_id
  );
$$;
ALTER FUNCTION shares_active_workspace(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION shares_active_workspace(UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT
  USING (auth.uid() = user_id OR is_account_member(account_id) OR shares_active_workspace(user_id));

-- ------------------------------------------------------------
-- Keep the active workspace in step with memberships.
--   role changed  → the profile's role follows, if that workspace is active
--   removed       → the user moves to another workspace they belong to,
--                   or to a fresh personal account if none is left
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_profile_from_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next account_memberships%ROWTYPE;
  v_name TEXT;
  v_email TEXT;
  v_org UUID;
  v_acct UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE profiles SET account_role = NEW.role
    WHERE user_id = NEW.user_id AND account_id = NEW.account_id;
    RETURN NEW;
  END IF;

  -- DELETE
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = OLD.user_id AND account_id = OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  -- The whole workspace is being deleted: the profile cascade handles it.
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN
    RETURN OLD;
  END IF;

  SELECT * INTO v_next FROM account_memberships
  WHERE user_id = OLD.user_id AND account_id <> OLD.account_id
  ORDER BY created_at
  LIMIT 1;

  IF FOUND THEN
    UPDATE profiles SET account_id = v_next.account_id, account_role = v_next.role
    WHERE user_id = OLD.user_id;
    RETURN OLD;
  END IF;

  -- No workspace left: start over with an empty personal account.
  SELECT full_name, email INTO v_name, v_email FROM profiles WHERE user_id = OLD.user_id;
  INSERT INTO organizations (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_name, ''), v_email, 'Minha conta'), OLD.user_id)
  RETURNING id INTO v_org;
  INSERT INTO accounts (name, owner_user_id, organization_id)
  VALUES (COALESCE(NULLIF(v_name, ''), v_email, 'Minha conta'), OLD.user_id, v_org)
  RETURNING id INTO v_acct;
  INSERT INTO account_memberships (account_id, user_id, role) VALUES (v_acct, OLD.user_id, 'owner');
  UPDATE profiles SET account_id = v_acct, account_role = 'owner' WHERE user_id = OLD.user_id;
  RETURN OLD;
END;
$$;
ALTER FUNCTION sync_profile_from_membership() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_profile_from_membership ON account_memberships;
CREATE TRIGGER sync_profile_from_membership
  AFTER UPDATE OF role OR DELETE ON account_memberships
  FOR EACH ROW EXECUTE FUNCTION sync_profile_from_membership();

-- ------------------------------------------------------------
-- Signup: client + workspace + membership
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_name TEXT;
  v_org UUID;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_name := COALESCE(NULLIF(v_full_name, ''), NEW.email, 'Minha conta');

  INSERT INTO public.organizations (name, owner_user_id)
  VALUES (v_name, NEW.id)
  RETURNING id INTO v_org;

  INSERT INTO public.accounts (name, owner_user_id, organization_id)
  VALUES (v_name, NEW.id, v_org)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_memberships (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ------------------------------------------------------------
-- list_my_workspaces()
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_my_workspaces();
CREATE OR REPLACE FUNCTION public.list_my_workspaces()
RETURNS TABLE (
  account_id UUID,
  name TEXT,
  role account_role_enum,
  status TEXT,
  plan TEXT,
  organization_id UUID,
  organization_name TEXT,
  is_active BOOLEAN,
  is_organization_owner BOOLEAN,
  organization_max_workspaces INTEGER,
  organization_workspaces INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    m.role,
    a.status,
    a.plan,
    o.id,
    o.name,
    (p.account_id = a.id),
    (o.owner_user_id = auth.uid()),
    o.max_workspaces,
    (SELECT count(*)::int FROM accounts x WHERE x.organization_id = o.id)
  FROM account_memberships m
  JOIN accounts a ON a.id = m.account_id
  LEFT JOIN organizations o ON o.id = a.organization_id
  LEFT JOIN profiles p ON p.user_id = auth.uid()
  WHERE m.user_id = auth.uid()
  ORDER BY o.name NULLS LAST, a.created_at;
$$;
ALTER FUNCTION public.list_my_workspaces() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_workspaces() TO authenticated;

-- ------------------------------------------------------------
-- switch_workspace(p_account_id)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.switch_workspace(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_role FROM account_memberships
  WHERE account_id = p_account_id AND user_id = auth.uid();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Você não participa deste workspace.' USING ERRCODE = '42501';
  END IF;
  UPDATE profiles SET account_id = p_account_id, account_role = v_role
  WHERE user_id = auth.uid();
END;
$$;
ALTER FUNCTION public.switch_workspace(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.switch_workspace(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_workspace(UUID) TO authenticated;

-- ------------------------------------------------------------
-- create_workspace(p_name) — only the client's owner, up to the
-- client's max_workspaces. The new workspace copies plan, status and
-- number limit from the active one, starts empty and becomes active.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_workspace(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src accounts%ROWTYPE;
  v_org organizations%ROWTYPE;
  v_count INT;
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_new UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'Informe um nome de até 80 caracteres.' USING ERRCODE = '22023';
  END IF;

  SELECT a.* INTO v_src FROM accounts a
  JOIN profiles p ON p.account_id = a.id
  WHERE p.user_id = auth.uid();
  IF v_src.id IS NULL OR v_src.organization_id IS NULL THEN
    RAISE EXCEPTION 'Workspace atual não encontrado.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = v_src.organization_id FOR UPDATE;
  IF v_org.owner_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Só o dono do cliente pode criar workspaces.' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count FROM accounts WHERE organization_id = v_org.id;
  IF v_count >= v_org.max_workspaces THEN
    RAISE EXCEPTION 'Limite de % workspace(s) atingido. Fale com o suporte para aumentar.', v_org.max_workspaces
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE organization_id = v_org.id AND lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'Já existe um workspace com esse nome.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO accounts (name, owner_user_id, organization_id, plan, status, max_numbers)
  VALUES (v_name, auth.uid(), v_org.id, v_src.plan, v_src.status, v_src.max_numbers)
  RETURNING id INTO v_new;

  INSERT INTO account_memberships (account_id, user_id, role) VALUES (v_new, auth.uid(), 'owner');
  UPDATE profiles SET account_id = v_new, account_role = 'owner' WHERE user_id = auth.uid();
  RETURN v_new;
END;
$$;
ALTER FUNCTION public.create_workspace(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- Member RPCs, now membership-based (same names, signatures and
-- error codes as 018).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role INTO v_account, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_target_role FROM account_memberships
  WHERE account_id = v_account AND user_id = p_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner' USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner' USING ERRCODE = '22023';
  END IF;
  UPDATE account_memberships SET role = p_new_role
  WHERE account_id = v_account AND user_id = p_user_id;
END;
$$;
ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- Removing a member takes them out of this workspace only. Their
-- other workspaces stay; with none left they get a personal account
-- (sync_profile_from_membership). Returns their active account after.
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_after UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role INTO v_account, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_target_role FROM account_memberships
  WHERE account_id = v_account AND user_id = p_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  -- Their links to this workspace's numbers and the rotation go too.
  DELETE FROM whatsapp_channel_members WHERE account_id = v_account AND user_id = p_user_id;
  UPDATE lead_rotation SET member_ids = array_remove(member_ids, p_user_id), updated_at = now()
  WHERE account_id = v_account AND p_user_id = ANY(member_ids);

  DELETE FROM account_memberships WHERE account_id = v_account AND user_id = p_user_id;

  SELECT account_id INTO v_after FROM profiles WHERE user_id = p_user_id;
  RETURN v_after;
END;
$$;
ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role INTO v_account, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_memberships WHERE account_id = v_account AND user_id = p_new_owner_user_id
  ) THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  -- Demote first: one owner per workspace (account_memberships_one_owner).
  UPDATE account_memberships SET role = 'admin' WHERE account_id = v_account AND user_id = auth.uid();
  UPDATE account_memberships SET role = 'owner' WHERE account_id = v_account AND user_id = p_new_owner_user_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id WHERE id = v_account;
END;
$$;
ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ------------------------------------------------------------
-- redeem_invitation: joining adds a workspace instead of replacing
-- the user's account. The invited workspace becomes active. An empty
-- personal account left behind (sole member, no data) is cleaned up.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old UUID;
  v_old_org UUID;
  v_disposable BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM account_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_memberships WHERE account_id = v_inv.account_id AND user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Você já participa deste workspace.' USING ERRCODE = '23505';
  END IF;

  SELECT p.account_id, a.organization_id INTO v_old, v_old_org
  FROM profiles p LEFT JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- The fresh personal account from signup: only the caller in it,
  -- the only workspace of its client, and no data at all.
  v_disposable := v_old IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM account_memberships WHERE account_id = v_old AND user_id <> v_caller_id)
    AND (v_old_org IS NULL OR (SELECT count(*) FROM accounts WHERE organization_id = v_old_org) = 1)
    AND NOT EXISTS (
      SELECT 1 FROM contacts WHERE account_id = v_old
      UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old
      UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old
      UNION ALL SELECT 1 FROM automations WHERE account_id = v_old
      UNION ALL SELECT 1 FROM flows WHERE account_id = v_old
      UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old
      UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old
      UNION ALL SELECT 1 FROM tags WHERE account_id = v_old
      UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old
      UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old
      UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old
      LIMIT 1
    );

  INSERT INTO account_memberships (account_id, user_id, role)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role);

  -- Move the profile first so deleting the old account can't cascade
  -- into it.
  UPDATE profiles SET account_id = v_inv.account_id, account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(), accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  IF v_disposable THEN
    DELETE FROM accounts WHERE id = v_old;
    IF v_old_org IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE organization_id = v_old_org) THEN
      DELETE FROM organizations WHERE id = v_old_org;
    END IF;
  END IF;

  RETURN v_inv.account_id;
END;
$$;
ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- Lead rotation: a rotation member counts when they belong to the
-- workspace, whatever workspace they have open right now.
-- ------------------------------------------------------------
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

  SELECT COALESCE(array_agg(r.u ORDER BY r.i), '{}') INTO v_pool
  FROM unnest(v_rot.member_ids) WITH ORDINALITY AS r(u, i)
  WHERE EXISTS (
    SELECT 1 FROM account_memberships m
    WHERE m.user_id = r.u AND m.account_id = v_account
      AND m.role IN ('owner', 'admin', 'agent')
  );
  IF v_pool = '{}' THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(u ORDER BY i), '{}') INTO v_narrow
  FROM unnest(v_pool) WITH ORDINALITY AS t(u, i)
  WHERE u = ANY(COALESCE(p_candidates, '{}'));
  IF v_narrow <> '{}' THEN v_pool := v_narrow; END IF;

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

-- ------------------------------------------------------------
-- /admin stats: members from memberships.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_account_stats()
RETURNS TABLE (
  account_id UUID,
  members INT,
  conversations_30d INT,
  messages_30d INT,
  last_message_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    (SELECT count(*)::int FROM account_memberships m WHERE m.account_id = a.id),
    (SELECT count(DISTINCT m.conversation_id)::int
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id AND m.created_at > now() - interval '30 days'),
    (SELECT count(*)::int
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id AND m.created_at > now() - interval '30 days'),
    (SELECT max(m.created_at)
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id)
  FROM accounts a;
$$;
ALTER FUNCTION admin_account_stats() OWNER TO postgres;
REVOKE ALL ON FUNCTION admin_account_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_account_stats() TO service_role;
