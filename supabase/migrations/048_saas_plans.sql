-- 048: SaaS plans + signup approval.
--
-- accounts.plan   — 'starter' (unofficial WhatsApp via QR code) or
--                   'pro' (official API through Coexy). Same features
--                   otherwise; set by the platform owner, no billing.
-- accounts.status — 'pending' until the platform owner approves a new
--                   signup, 'active' to use the app, 'blocked' to cut
--                   access. Only the service role (the /admin panel)
--                   can change plan or status.
--
-- Enforcement: is_account_member() — used by every tenant RLS policy —
-- now also requires the account to be active, so a pending or blocked
-- organization cannot read or write tenant data even through the
-- Supabase client directly. Members can still read their own account
-- row (to see the "under review" screen) through is_account_member_any().

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'starter'
    CHECK (plan IN ('starter', 'pro')),
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'blocked')),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

-- Accounts that exist before this migration keep working: they were
-- created by the platform owner's own team.
UPDATE accounts SET status = 'active', plan = 'pro', status_changed_at = now()
WHERE status_changed_at IS NULL;

CREATE INDEX IF NOT EXISTS accounts_status_idx ON accounts(status);

-- Plan and status are the platform owner's call: block any change that
-- does not come from the service role (accounts_update lets account
-- admins edit the row, e.g. its name).
CREATE OR REPLACE FUNCTION protect_account_plan_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.status IS DISTINCT FROM OLD.status)
     AND coalesce(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'plan and status can only be changed by the platform owner'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_account_plan_status ON accounts;
CREATE TRIGGER protect_account_plan_status BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION protect_account_plan_status();

-- Membership regardless of account status.
CREATE OR REPLACE FUNCTION is_account_member_any(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
  );
$$;

ALTER FUNCTION is_account_member_any(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_any(UUID) TO authenticated, service_role;

-- Same as 017, plus: the account must be active.
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
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
      AND a.status = 'active'
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member_any(id));

-- What the platform owner did in /admin. Service role only.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_email TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_account_idx ON admin_audit_log(account_id, created_at DESC);
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Per-organization numbers for the /admin panel. Service role only.
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
    (SELECT count(*)::int FROM profiles p WHERE p.account_id = a.id),
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
