// ============================================================
// Platform owner ("super admin") access for the /admin panel.
//
// The SaaS owner is whoever's e-mail is listed in SUPER_ADMIN_EMAILS
// (comma separated, server-only env). Super admins manage every
// organization — plans, signup approval, blocking — through the
// service-role client, so these helpers are the only gate in front of
// those routes.
// ============================================================

import { createClient as createAdminClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";

export function superAdminEmails(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return superAdminEmails().includes(email.trim().toLowerCase());
}

export interface SuperAdminContext {
  userId: string;
  email: string;
  /** Service-role client: bypasses RLS, every organization is visible. */
  admin: SupabaseClient;
}

/** Throws Unauthorized / Forbidden unless the caller is a super admin. */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();
  // A confirmed address only: an unconfirmed signup must not borrow
  // the owner's e-mail to get in.
  if (!user.email_confirmed_at || !isSuperAdminEmail(user.email)) {
    throw new ForbiddenError();
  }
  return {
    userId: user.id,
    email: user.email!.toLowerCase(),
    admin: createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ),
  };
}
