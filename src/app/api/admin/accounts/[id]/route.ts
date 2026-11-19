import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireSuperAdmin } from "@/lib/admin/super-admin";
import { logoutDapiSession } from "@/lib/whatsapp/dapi-connection";

type Action =
  | { action: "approve"; plan: "starter" | "pro" }
  | { action: "reject" }
  | { action: "block" }
  | { action: "unblock" }
  | { action: "set_plan"; plan: "starter" | "pro" }
  | { action: "disconnect_whatsapp" }
  | { action: "set_max_numbers"; max_numbers: number }
  | { action: "set_max_workspaces"; max_workspaces: number }
  | { action: "set_api_enabled"; api_enabled: boolean }
  | { action: "set_api_rate_limit"; api_rate_limit: number | null };

function parseAction(body: unknown): Action | null {
  if (!body || typeof body !== "object") return null;
  const b = body as {
    action?: unknown;
    plan?: unknown;
    max_numbers?: unknown;
    max_workspaces?: unknown;
    api_enabled?: unknown;
    api_rate_limit?: unknown;
  };
  const plan = b.plan === "starter" || b.plan === "pro" ? b.plan : null;
  switch (b.action) {
    case "approve":
    case "set_plan":
      return plan ? { action: b.action, plan } : null;
    case "reject":
    case "block":
    case "unblock":
    case "disconnect_whatsapp":
      return { action: b.action };
    case "set_max_numbers": {
      const n = Number(b.max_numbers);
      return Number.isInteger(n) && n >= 1 && n <= 50 ? { action: b.action, max_numbers: n } : null;
    }
    case "set_max_workspaces": {
      const n = Number(b.max_workspaces);
      return Number.isInteger(n) && n >= 1 && n <= 50 ? { action: b.action, max_workspaces: n } : null;
    }
    case "set_api_enabled":
      return typeof b.api_enabled === "boolean" ? { action: b.action, api_enabled: b.api_enabled } : null;
    case "set_api_rate_limit": {
      // null = back to the plan default (Starter 60, Pro 120 per minute).
      if (b.api_rate_limit === null) return { action: b.action, api_rate_limit: null };
      const n = Number(b.api_rate_limit);
      return Number.isInteger(n) && n >= 1 && n <= 10000 ? { action: b.action, api_rate_limit: n } : null;
    }
    default:
      return null;
  }
}

/**
 * Platform-owner actions on one organization: approve (with a plan),
 * reject, block, unblock, change plan, disconnect WhatsApp (every
 * number of the account), set the Starter number limit, set how many
 * workspaces the client may have, switch the API and MCP on or off and
 * set its per-minute limit. Each one is
 * written to admin_audit_log.
 *
 * A plan change also disconnects the WhatsApp number, since Starter
 * (QR code) and Pro (official API) connect in different ways; the
 * conversation history stays.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { admin, email } = await requireSuperAdmin();
    const { id } = await params;
    const action = parseAction(await request.json().catch(() => null));
    if (!action) {
      return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
    }

    const { data: account, error: loadErr } = await admin
      .from("accounts")
      .select("id, plan, status, organization_id, api_enabled, api_rate_limit")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!account) {
      return NextResponse.json({ error: "Organização não encontrada." }, { status: 404 });
    }

    const disconnect = async () => {
      const { error } = await admin
        .from("whatsapp_config")
        .update({ status: "disconnected", updated_at: new Date().toISOString() })
        .eq("account_id", id);
      if (error) throw error;
      await logoutDapiSession(admin, id);
    };

    let update: Record<string, string | number | boolean | null> | null = null;
    switch (action.action) {
      case "approve":
        update = { status: "active", plan: action.plan };
        break;
      case "reject":
      case "block":
        update = { status: "blocked" };
        break;
      case "unblock":
        update = { status: "active" };
        break;
      case "set_plan":
        if (action.plan !== account.plan) {
          update = { plan: action.plan };
          await disconnect();
        }
        break;
      case "disconnect_whatsapp":
        await disconnect();
        break;
      case "set_max_numbers":
        // Numbers already connected stay; the limit only blocks new ones.
        update = { max_numbers: action.max_numbers };
        break;
      case "set_api_enabled":
        // Off cuts every API key and connected app (claude.ai) of this
        // workspace on their next call; nothing is deleted.
        update = { api_enabled: action.api_enabled };
        break;
      case "set_api_rate_limit":
        update = { api_rate_limit: action.api_rate_limit };
        break;
      case "set_max_workspaces": {
        // The limit is the client's (every workspace of it); existing
        // workspaces stay, the limit only blocks new ones.
        if (!account.organization_id) {
          return NextResponse.json({ error: "Organização sem cliente vinculado." }, { status: 400 });
        }
        const { error } = await admin
          .from("organizations")
          .update({ max_workspaces: action.max_workspaces, updated_at: new Date().toISOString() })
          .eq("id", account.organization_id);
        if (error) throw error;
        break;
      }
    }

    if (update) {
      const { error } = await admin.from("accounts").update(update).eq("id", id);
      if (error) throw error;
    }

    const { error: auditErr } = await admin.from("admin_audit_log").insert({
      actor_email: email,
      account_id: id,
      action: action.action,
      details: {
        before: {
          plan: account.plan,
          status: account.status,
          api_enabled: account.api_enabled,
          api_rate_limit: account.api_rate_limit,
        },
        ...action,
      },
    });
    if (auditErr) console.error("[admin/accounts] audit log failed:", auditErr.message);

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err && typeof err === "object" && "message" in err && !(err instanceof Error)) {
      console.error("[admin/accounts] update failed:", (err as { message: string }).message);
      return NextResponse.json({ error: "Não foi possível salvar." }, { status: 500 });
    }
    return toErrorResponse(err);
  }
}
