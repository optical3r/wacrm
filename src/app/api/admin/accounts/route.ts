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

    const [accountsRes, profilesRes, configsRes, statsRes, orgsRes] = await Promise.all([
      admin
        .from("accounts")
        .select("id, name, plan, status, owner_user_id, created_at, status_changed_at, max_numbers, organization_id")
        .order("created_at", { ascending: false }),
      admin.from("profiles").select("user_id, email, full_name, account_id"),
      admin
        .from("whatsapp_config")
        .select("account_id, status, phone_number_id, connected_at"),
      admin.rpc("admin_account_stats"),
      admin.from("organizations").select("id, name, max_workspaces"),
    ]);

    const failed = [accountsRes, profilesRes, configsRes, statsRes, orgsRes].find((r) => r.error);
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
    // Several numbers per Starter account (migration 051).
    const configs = new Map<string, Config[]>();
    for (const c of (configsRes.data ?? []) as Config[]) {
      configs.set(c.account_id, [...(configs.get(c.account_id) ?? []), c]);
    }
    type Org = { id: string; name: string; max_workspaces: number };
    const orgs = new Map(((orgsRes.data ?? []) as Org[]).map((o) => [o.id, o]));
    const workspacesPerOrg = new Map<string, number>();
    for (const a of accountsRes.data ?? []) {
      const org = a.organization_id as string | null;
      if (org) workspacesPerOrg.set(org, (workspacesPerOrg.get(org) ?? 0) + 1);
    }
    const stats = new Map(((statsRes.data ?? []) as Stat[]).map((s) => [s.account_id, s]));

    const accounts = (accountsRes.data ?? [])
      .map((a) => {
        const owner = profiles.find((p) => p.user_id === a.owner_user_id);
        const org = a.organization_id ? orgs.get(a.organization_id as string) : undefined;
        const stat = stats.get(a.id);
        const numbers = configs.get(a.id) ?? [];
        const connected = numbers.filter((c) => c.status === "connected");
        const lastConnected = connected
          .map((c) => c.connected_at)
          .filter(Boolean)
          .sort()
          .pop() ?? null;
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
          max_numbers: (a.max_numbers as number | null) ?? 5,
          organization: org
            ? {
                id: org.id,
                name: org.name,
                max_workspaces: org.max_workspaces,
                workspaces: workspacesPerOrg.get(org.id) ?? 1,
              }
            : null,
          whatsapp: numbers.length
            ? {
                status: connected.length ? "connected" : "disconnected",
                connected_at: lastConnected,
                connected: connected.length,
                total: numbers.length,
              }
            : null,
        };
      })
      .filter((a) => a.members > 0);

    // Workspaces of the same client side by side, the client placed
    // where its newest workspace was.
    const groups = new Map<string, typeof accounts>();
    for (const a of accounts) {
      const key = a.organization?.id ?? a.id;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const grouped = [...groups.values()].flatMap((g) =>
      g.sort((x, y) => x.created_at.localeCompare(y.created_at)),
    );

    return NextResponse.json({ accounts: grouped });
  } catch (err) {
    return toErrorResponse(err);
  }
}
