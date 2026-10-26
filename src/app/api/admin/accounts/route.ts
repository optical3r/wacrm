import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireSuperAdmin } from "@/lib/admin/super-admin";

/**
 * Every organization on the platform, for the /admin panel.
 *
 * Accounts nobody belongs to any more are left out: they are the
 * personal accounts left behind when someone signs up through an
 * invitation and moves into the inviting organization.
 */
export async function GET() {
  try {
    const { admin } = await requireSuperAdmin();

    const [accountsRes, profilesRes, configsRes, statsRes] = await Promise.all([
      admin
        .from("accounts")
        .select("id, name, plan, status, owner_user_id, created_at, status_changed_at")
        .order("created_at", { ascending: false }),
      admin.from("profiles").select("user_id, email, full_name, account_id"),
      admin
        .from("whatsapp_config")
        .select("account_id, status, phone_number_id, connected_at"),
      admin.rpc("admin_account_stats"),
    ]);

    const failed = [accountsRes, profilesRes, configsRes, statsRes].find((r) => r.error);
    if (failed?.error) {
      console.error("[admin/accounts] load failed:", failed.error.message);
      return NextResponse.json({ error: "Não foi possível carregar as organizações." }, { status: 500 });
    }

    type Profile = { user_id: string; email: string; full_name: string | null; account_id: string | null };
    type Config = { account_id: string; status: string; phone_number_id: string; connected_at: string | null };
    type Stat = {
      account_id: string;
      members: number;
      conversations_30d: number;
      messages_30d: number;
      last_message_at: string | null;
    };

    const profiles = (profilesRes.data ?? []) as Profile[];
    const configs = new Map(((configsRes.data ?? []) as Config[]).map((c) => [c.account_id, c]));
    const stats = new Map(((statsRes.data ?? []) as Stat[]).map((s) => [s.account_id, s]));

    const accounts = (accountsRes.data ?? [])
      .map((a) => {
        const owner = profiles.find((p) => p.user_id === a.owner_user_id);
        const stat = stats.get(a.id);
        const config = configs.get(a.id);
        return {
          id: a.id as string,
          name: a.name as string,
          plan: a.plan as "starter" | "pro",
          status: a.status as "pending" | "active" | "blocked",
          created_at: a.created_at as string,
          status_changed_at: a.status_changed_at as string | null,
          owner_email: owner?.email ?? null,
          owner_name: owner?.full_name ?? null,
          members: stat?.members ?? 0,
          conversations_30d: stat?.conversations_30d ?? 0,
          messages_30d: stat?.messages_30d ?? 0,
          last_message_at: stat?.last_message_at ?? null,
          whatsapp: config
            ? { status: config.status, connected_at: config.connected_at }
            : null,
        };
      })
      .filter((a) => a.members > 0);

    return NextResponse.json({ accounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
