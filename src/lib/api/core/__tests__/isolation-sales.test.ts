// ============================================================
// Phase 3 isolation: pipelines, deals, quick replies, templates,
// broadcasts, team and numbers. Account A's key against account B's
// rows must behave as if they did not exist, and never change them.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey, hashApiKey } from "@/lib/api-keys/keys";
import { API_SCOPES } from "@/lib/api-keys/scopes";
import { createFakeSupabase } from "./fake-supabase";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U_A = "a9000000-0000-4000-8000-000000000001";
const U_B = "b9000000-0000-4000-8000-000000000001";
const ID = {
  contactA: "a1000000-0000-4000-8000-000000000001",
  contactB: "b1000000-0000-4000-8000-000000000001",
  pipeA: "a3000000-0000-4000-8000-000000000001",
  pipeB: "b3000000-0000-4000-8000-000000000001",
  stageA1: "a4000000-0000-4000-8000-000000000001",
  stageA2: "a4000000-0000-4000-8000-000000000002",
  stageB: "b4000000-0000-4000-8000-000000000001",
  dealA: "a5000000-0000-4000-8000-000000000001",
  dealB: "b5000000-0000-4000-8000-000000000001",
  qrA: "a6000000-0000-4000-8000-000000000001",
  qrB: "b6000000-0000-4000-8000-000000000001",
  tplA: "a7000000-0000-4000-8000-000000000001",
  tplB: "b7000000-0000-4000-8000-000000000001",
  bcA: "a8000000-0000-4000-8000-000000000001",
  bcB: "b8000000-0000-4000-8000-000000000001",
  chA: "ac000000-0000-4000-8000-000000000001",
  chB: "bc000000-0000-4000-8000-000000000001",
};
const T0 = "2026-11-01T10:00:00.000Z";

let fake: ReturnType<typeof createFakeSupabase>;

function seed(planA: "pro" | "starter" = "pro") {
  fake = createFakeSupabase({
    accounts: [
      { id: A, plan: planA, status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_A, default_currency: "BRL" },
      { id: B, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_B, default_currency: "USD" },
    ],
    account_memberships: [
      { account_id: A, user_id: U_A, role: "owner", created_at: T0 },
      { account_id: B, user_id: U_B, role: "owner", created_at: T0 },
    ],
    profiles: [
      { user_id: U_A, full_name: "Dono A", email: "a@example.com", avatar_url: null },
      { user_id: U_B, full_name: "Dono B", email: "b@example.com", avatar_url: null },
    ],
    contacts: [
      { id: ID.contactA, account_id: A, phone: "+5511900000001", name: "Ana", is_group: false },
      { id: ID.contactB, account_id: B, phone: "+5511900000002", name: "Bruno", is_group: false },
    ],
    pipelines: [
      { id: ID.pipeA, account_id: A, name: "Vendas A", created_at: T0 },
      { id: ID.pipeB, account_id: B, name: "Vendas B", created_at: T0 },
    ],
    pipeline_stages: [
      { id: ID.stageA1, pipeline_id: ID.pipeA, name: "Novo", position: 0, color: "#111111" },
      { id: ID.stageA2, pipeline_id: ID.pipeA, name: "Ganho", position: 1, color: "#222222" },
      { id: ID.stageB, pipeline_id: ID.pipeB, name: "Novo B", position: 0, color: "#333333" },
    ],
    deals: [
      { id: ID.dealA, account_id: A, title: "Negócio A", value: 10, status: "open", pipeline_id: ID.pipeA, stage_id: ID.stageA1, created_at: T0 },
      { id: ID.dealB, account_id: B, title: "Negócio B", value: 99, status: "open", pipeline_id: ID.pipeB, stage_id: ID.stageB, created_at: T0 },
    ],
    quick_replies: [
      { id: ID.qrA, account_id: A, title: "Oi A", kind: "text", content_text: "Olá", created_at: T0 },
      { id: ID.qrB, account_id: B, title: "Oi B", kind: "text", content_text: "segredo", created_at: T0 },
    ],
    message_templates: [
      { id: ID.tplA, account_id: A, name: "boas_vindas", language: "pt_BR", status: "APPROVED", body_text: "Oi", created_at: T0 },
      { id: ID.tplB, account_id: B, name: "segredo_b", language: "pt_BR", status: "APPROVED", body_text: "B", meta_template_id: "m-b", created_at: T0 },
    ],
    broadcasts: [
      { id: ID.bcA, account_id: A, name: "Promo A", status: "sending", created_at: T0 },
      { id: ID.bcB, account_id: B, name: "Promo B", status: "sending", created_at: T0 },
    ],
    broadcast_recipients: [
      { id: "ra-1", broadcast_id: ID.bcA, contact_id: ID.contactA, status: "sent", created_at: T0 },
      { id: "ra-2", broadcast_id: ID.bcA, contact_id: ID.contactA, status: "pending", created_at: T0 },
      { id: "rb-1", broadcast_id: ID.bcB, contact_id: ID.contactB, status: "pending", created_at: T0 },
    ],
    whatsapp_config: [
      { id: ID.chA, account_id: A, label: "Loja", phone_number_id: "111", access_token: "enc-secret-a", verify_token: "v-a", status: "connected", is_default: true, created_at: T0 },
      { id: ID.chB, account_id: B, label: "Loja B", phone_number_id: "222", access_token: "enc-secret-b", verify_token: "v-b", status: "connected", is_default: true, created_at: T0 },
    ],
    whatsapp_channel_members: [
      { channel_id: ID.chA, user_id: U_A, account_id: A },
      { channel_id: ID.chB, user_id: U_B, account_id: B },
    ],
    lead_rotation: [
      { account_id: A, enabled: true, member_ids: [U_A], last_user_id: U_A },
      { account_id: B, enabled: true, member_ids: [U_B], last_user_id: U_B },
    ],
    api_request_log: [],
  });
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fake }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => {} }));
const metaDelete = vi.fn(async () => ({}));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/meta-api")>()),
  deleteMessageTemplate: (...a: unknown[]) => metaDelete(...(a as [])),
  submitMessageTemplate: async () => {
    throw new Error("must not reach Meta in tests");
  },
}));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => `plain:${v}`, encrypt: (v: string) => v }));

const KEY_A = generateApiKey().plaintext;
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: async (hash: string) =>
    hash === hashApiKey(KEY_A)
      ? { id: "key-a", account_id: A, created_by: U_A, name: "A", scopes: [...API_SCOPES], expires_at: null, revoked_at: null }
      : null,
  touchLastUsed: () => {},
  getAccountName: async () => "Conta A",
}));

const pipelines = await import("@/app/api/v1/pipelines/route");
const pipeline = await import("@/app/api/v1/pipelines/[id]/route");
const stages = await import("@/app/api/v1/pipelines/[id]/stages/route");
const stage = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
const deals = await import("@/app/api/v1/deals/route");
const deal = await import("@/app/api/v1/deals/[id]/route");
const quickReplies = await import("@/app/api/v1/quick-replies/route");
const quickReply = await import("@/app/api/v1/quick-replies/[id]/route");
const templates = await import("@/app/api/v1/templates/route");
const template = await import("@/app/api/v1/templates/[id]/route");
const broadcasts = await import("@/app/api/v1/broadcasts/route");
const broadcast = await import("@/app/api/v1/broadcasts/[id]/route");
const recipients = await import("@/app/api/v1/broadcasts/[id]/recipients/route");
const cancel = await import("@/app/api/v1/broadcasts/[id]/cancel/route");
const team = await import("@/app/api/v1/team/route");
const channels = await import("@/app/api/v1/channels/route");
const rotation = await import("@/app/api/v1/lead-rotation/route");
const emit = await import("@/app/api/webhooks/emit/route");

function req(path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`https://crm.example.com${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${KEY_A}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (res: Response) => (await res.json()) as { data?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const row = (table: string, id: string) => fake.tables[table].find((r) => r.id === id);
const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeEach(() => {
  seed();
  metaDelete.mockClear();
  process.env.WHATSAPP_TEMPLATES_DRY_RUN = "1";
});

describe("pipelines", () => {
  it("lists only A's pipelines, with A's stages", async () => {
    const body = await json(await pipelines.GET(req("/api/v1/pipelines")));
    expect(ids(body.data)).toEqual([ID.pipeA]);
    expect(ids(body.data[0].stages)).toEqual([ID.stageA1, ID.stageA2]);
  });

  it("B's pipeline cannot be read, renamed, deleted or get stages", async () => {
    expect((await pipeline.GET(req(`/api/v1/pipelines/${ID.pipeB}`), p({ id: ID.pipeB }))).status).toBe(404);
    const renamed = await pipeline.PATCH(
      req(`/api/v1/pipelines/${ID.pipeB}`, { method: "PATCH", body: { name: "x" } }),
      p({ id: ID.pipeB })
    );
    expect(renamed.status).toBe(404);
    expect((await pipeline.DELETE(req(`/api/v1/pipelines/${ID.pipeB}`, { method: "DELETE" }), p({ id: ID.pipeB }))).status).toBe(404);
    const added = await stages.POST(
      req(`/api/v1/pipelines/${ID.pipeB}/stages`, { method: "POST", body: { name: "x" } }),
      p({ id: ID.pipeB })
    );
    expect(added.status).toBe(404);
    expect(row("pipelines", ID.pipeB)?.name).toBe("Vendas B");
    expect(fake.tables.pipeline_stages.filter((s) => s.pipeline_id === ID.pipeB)).toHaveLength(1);
  });

  it("B's stage cannot be edited or deleted, not even through A's pipeline", async () => {
    for (const pipe of [ID.pipeA, ID.pipeB]) {
      const patched = await stage.PATCH(
        req(`/api/v1/pipelines/${pipe}/stages/${ID.stageB}`, { method: "PATCH", body: { name: "x" } }),
        p({ id: pipe, stageId: ID.stageB })
      );
      expect(patched.status).toBe(404);
      const deleted = await stage.DELETE(
        req(`/api/v1/pipelines/${pipe}/stages/${ID.stageB}`, { method: "DELETE" }),
        p({ id: pipe, stageId: ID.stageB })
      );
      expect(deleted.status).toBe(404);
    }
    expect(row("pipeline_stages", ID.stageB)?.name).toBe("Novo B");
  });

  it("a new pipeline lands in A with default stages", async () => {
    const res = await pipelines.POST(req("/api/v1/pipelines", { method: "POST", body: { name: "Novo", account_id: B } }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(row("pipelines", body.data.id)?.account_id).toBe(A);
    expect(body.data.stages).toHaveLength(5);
  });

  it("a stage with deals cannot be deleted", async () => {
    const res = await stage.DELETE(
      req(`/api/v1/pipelines/${ID.pipeA}/stages/${ID.stageA1}`, { method: "DELETE" }),
      p({ id: ID.pipeA, stageId: ID.stageA1 })
    );
    expect(res.status).toBe(400);
  });
});

describe("deals", () => {
  it("lists only A's deals, even when filtering by B's pipeline", async () => {
    expect(ids((await json(await deals.GET(req("/api/v1/deals")))).data)).toEqual([ID.dealA]);
    const filtered = await json(await deals.GET(req(`/api/v1/deals?pipeline_id=${ID.pipeB}`)));
    expect(filtered.data).toEqual([]);
  });

  it("refuses B's pipeline, stage, contact or member on create", async () => {
    const bodies = [
      { title: "x", pipeline_id: ID.pipeB },
      { title: "x", pipeline_id: ID.pipeA, stage_id: ID.stageB },
      { title: "x", pipeline_id: ID.pipeA, contact_id: ID.contactB },
      { title: "x", pipeline_id: ID.pipeA, assigned_to: U_B },
    ];
    for (const body of bodies) {
      const res = await deals.POST(req("/api/v1/deals", { method: "POST", body }));
      expect(res.status).toBe(400);
    }
    expect(fake.tables.deals).toHaveLength(2);
  });

  it("creates in A, first stage, A's currency", async () => {
    const res = await deals.POST(
      req("/api/v1/deals", {
        method: "POST",
        body: { title: "Novo", pipeline_id: ID.pipeA, contact_id: ID.contactA, account_id: B },
      })
    );
    expect(res.status).toBe(201);
    const created = row("deals", (await json(res)).data.id);
    expect(created?.account_id).toBe(A);
    expect(created?.stage_id).toBe(ID.stageA1);
    expect(created?.currency).toBe("BRL");
  });

  it("B's deal cannot be read, changed or deleted", async () => {
    expect((await deal.GET(req(`/api/v1/deals/${ID.dealB}`), p({ id: ID.dealB }))).status).toBe(404);
    const patched = await deal.PATCH(
      req(`/api/v1/deals/${ID.dealB}`, { method: "PATCH", body: { status: "won" } }),
      p({ id: ID.dealB })
    );
    expect(patched.status).toBe(404);
    expect((await deal.DELETE(req(`/api/v1/deals/${ID.dealB}`, { method: "DELETE" }), p({ id: ID.dealB }))).status).toBe(404);
    expect(row("deals", ID.dealB)?.status).toBe("open");
  });

  it("A's deal cannot move into B's stage or pipeline", async () => {
    for (const body of [{ stage_id: ID.stageB }, { pipeline_id: ID.pipeB }]) {
      const res = await deal.PATCH(req(`/api/v1/deals/${ID.dealA}`, { method: "PATCH", body }), p({ id: ID.dealA }));
      expect(res.status).toBe(400);
    }
    const moved = await deal.PATCH(
      req(`/api/v1/deals/${ID.dealA}`, { method: "PATCH", body: { stage_id: ID.stageA2, status: "won" } }),
      p({ id: ID.dealA })
    );
    expect(moved.status).toBe(200);
    expect(row("deals", ID.dealA)).toMatchObject({ stage_id: ID.stageA2, status: "won" });
  });
});

describe("quick replies", () => {
  it("lists only A's and leaves B's alone", async () => {
    expect(ids((await json(await quickReplies.GET(req("/api/v1/quick-replies")))).data)).toEqual([ID.qrA]);
    expect((await quickReply.GET(req(`/api/v1/quick-replies/${ID.qrB}`), p({ id: ID.qrB }))).status).toBe(404);
    const patched = await quickReply.PATCH(
      req(`/api/v1/quick-replies/${ID.qrB}`, { method: "PATCH", body: { title: "x" } }),
      p({ id: ID.qrB })
    );
    expect(patched.status).toBe(404);
    expect((await quickReply.DELETE(req(`/api/v1/quick-replies/${ID.qrB}`, { method: "DELETE" }), p({ id: ID.qrB }))).status).toBe(404);
    expect(row("quick_replies", ID.qrB)?.title).toBe("Oi B");
  });

  it("creates in A and validates the content", async () => {
    const bad = await quickReplies.POST(req("/api/v1/quick-replies", { method: "POST", body: { title: "x", kind: "text" } }));
    expect(bad.status).toBe(400);
    const res = await quickReplies.POST(
      req("/api/v1/quick-replies", { method: "POST", body: { title: "x", content_text: "oi", account_id: B } })
    );
    expect(res.status).toBe(201);
    expect(row("quick_replies", (await json(res)).data.id)?.account_id).toBe(A);
  });
});

describe("templates (Pro)", () => {
  it("lists only A's and cannot delete B's", async () => {
    expect(ids((await json(await templates.GET(req("/api/v1/templates")))).data)).toEqual([ID.tplA]);
    expect((await template.GET(req(`/api/v1/templates/${ID.tplB}`), p({ id: ID.tplB }))).status).toBe(404);
    const del = await template.DELETE(req(`/api/v1/templates/${ID.tplB}`, { method: "DELETE" }), p({ id: ID.tplB }));
    expect(del.status).toBe(404);
    expect(row("message_templates", ID.tplB)).toBeTruthy();
    expect(metaDelete).not.toHaveBeenCalled();
  });

  it("creates in A (dry run)", async () => {
    const res = await templates.POST(
      req("/api/v1/templates", {
        method: "POST",
        body: { name: "oferta_nova", category: "Marketing", language: "pt_BR", body_text: "Olá, temos ofertas", account_id: B },
      })
    );
    expect(res.status).toBe(201);
    const created = fake.tables.message_templates.find((t) => t.name === "oferta_nova");
    expect(created?.account_id).toBe(A);
  });

  it("are refused on the Starter plan", async () => {
    seed("starter");
    expect((await templates.GET(req("/api/v1/templates"))).status).toBe(403);
    expect((await broadcasts.GET(req("/api/v1/broadcasts"))).status).toBe(403);
  });
});

describe("broadcasts", () => {
  it("lists and reads only A's", async () => {
    expect(ids((await json(await broadcasts.GET(req("/api/v1/broadcasts")))).data)).toEqual([ID.bcA]);
    expect((await broadcast.GET(req(`/api/v1/broadcasts/${ID.bcB}`), p({ id: ID.bcB }))).status).toBe(404);
    expect((await recipients.GET(req(`/api/v1/broadcasts/${ID.bcB}/recipients`), p({ id: ID.bcB }))).status).toBe(404);
    const list = await json(await recipients.GET(req(`/api/v1/broadcasts/${ID.bcA}/recipients`), p({ id: ID.bcA })));
    expect(ids(list.data).sort()).toEqual(["ra-1", "ra-2"]);
  });

  it("cannot cancel B's; cancelling A's stops only the pending", async () => {
    expect((await cancel.POST(req(`/api/v1/broadcasts/${ID.bcB}/cancel`, { method: "POST" }), p({ id: ID.bcB }))).status).toBe(404);
    expect(row("broadcast_recipients", "rb-1")?.status).toBe("pending");
    expect(row("broadcasts", ID.bcB)?.status).toBe("sending");

    const res = await cancel.POST(req(`/api/v1/broadcasts/${ID.bcA}/cancel`, { method: "POST" }), p({ id: ID.bcA }));
    expect(res.status).toBe(200);
    expect(row("broadcast_recipients", "ra-1")?.status).toBe("sent");
    expect(row("broadcast_recipients", "ra-2")?.status).toBe("failed");
    expect(row("broadcasts", ID.bcA)?.status).toBe("sent");
  });
});

describe("team and numbers", () => {
  it("team shows only A's people", async () => {
    const body = await json(await team.GET(req("/api/v1/team")));
    expect(body.data.map((m: { user_id: string }) => m.user_id)).toEqual([U_A]);
  });

  it("channels show only A's numbers and never a token", async () => {
    const res = await channels.GET(req("/api/v1/channels"));
    const text = await res.clone().text();
    const body = await json(res);
    expect(ids(body.data)).toEqual([ID.chA]);
    expect(body.data[0].member_ids).toEqual([U_A]);
    expect(text).not.toContain("enc-secret");
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("verify_token");
  });

  it("lead rotation is A's", async () => {
    const body = await json(await rotation.GET(req("/api/v1/lead-rotation")));
    expect(body.data.member_ids).toEqual([U_A]);
  });
});

describe("webhook emit relay", () => {
  const emitReq = (secret: string, body: unknown) =>
    new Request("https://crm.example.com/api/webhooks/emit", {
      method: "POST",
      headers: { "x-cron-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("needs the cron secret and only takes database events", async () => {
    process.env.AUTOMATION_CRON_SECRET = "segredo-cron";
    expect((await emit.POST(emitReq("errado-cron!", { account_id: A, event: "deal.created" }))).status).toBe(401);
    expect((await emit.POST(emitReq("segredo-cron", { account_id: A, event: "message.received" }))).status).toBe(400);
    expect((await emit.POST(emitReq("segredo-cron", { account_id: "x", event: "deal.created" }))).status).toBe(400);
    expect((await emit.POST(emitReq("segredo-cron", { account_id: A, event: "deal.created", data: {} }))).status).toBe(200);
  });
});
