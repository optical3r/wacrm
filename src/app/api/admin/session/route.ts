import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminEmail } from "@/lib/admin/super-admin";

/** Whether the signed-in user is the platform owner (shows the Admin link). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isSuperAdmin = Boolean(
    user?.email_confirmed_at && isSuperAdminEmail(user.email),
  );
  return NextResponse.json({ isSuperAdmin });
}
