// ============================================================
// Account isolation across the public API: every route is called with
// account A's key against account B's data, and must answer as if
// B's rows did not exist (404 or absent from lists), never touching
// them. Runs the real route handlers on an in-memory database.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey, hashApiKey } from "@/lib/api-keys/keys";
import { API_SCOPES } from "@/lib/api-keys/scopes";
import { createFakeSupabase } from "./fake-supabase";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = {
  contactA: "a1000000-0000-4000-8000-000000000001",
  contactB: "b1000000-0000-4000-8000-000000000001",
  convA: "a2000000-0000-4000-8000-000000000001",
  convB: "b2000000-0000-4000-8000-000000000001",
  broadcastB: "b3000000-0000-4000-8000-000000000001",
  hookA: "a4000000-0000-4000-8000-000000000001",
  hookB: "b4000000-0000-4000-8000-000000000001",
};

let fake: ReturnType<typeof createFakeSupabase>;

function seed() {
  fake = createFakeSupabase({
    accounts: [
      { id: A, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: "u-a", name: "Conta A" },
      { id: B, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: "u-b", name: "Conta B" },
    ],
    contacts: [
      { id: ID.contactA, account_id: A, phone: "+5511900000001", name: "Ana", is_group: false, created_at: "2026-11-01" },
      { id: ID.contactB, account_id: B, phone: "+5511900000002", name: "Bruno", is_group: false, created_at: "2026-11-01" },
    ],
    conversations: [
      { id: ID.convA, account_id: A, contact_id: ID.contactA, status: "open", is_group: false, created_at: "2026-11-01" },
      { id: ID.convB, account_id: B, contact_id: ID.contactB, status: "open", is_group: false, created_at: "2026-11-01" },
    ],
    messages: [
      { id: "m-a", conversation_id: ID.convA, content_text: "oi A", created_at: "2026-11-01" },
      { id: "m-b", conversation_id: ID.convB, content_text: "segredo B", created_at: "2026-11-01" },
    ],
    broadcasts: [{ id: ID.broadcastB, account_id: B, name: "Campanha B", status: "sent" }],
    webhook_endpoints: [
      { id: ID.hookA, account_id: A, url: "https://a.example/h", events: ["message.received"], is_active: true },
      { id: ID.hookB, account_id: B, url: "https://b.example/h", events: ["message.received"], is_active: true },
    ],
    whatsapp_config: [],
    api_request_log: [],
  });
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fake }));

const KEY_A = generateApiKey().plaintext;
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: async (hash: string) =>
    hash === hashApiKey(KEY_A)
      ? { id: "key-a", account_id: A, created_by: "u-a", name: "A", scopes: [...API_SCOPES], expires_at: null, revoked_at: null }
      : null,
  touchLastUsed: () => {},
  getAccountName: async (id: string) => (id === A ? "Conta A" : "Conta B"),
}));

const contacts = await import("@/app/api/v1/contacts/route");
const contact = await import("@/app/api/v1/contacts/[id]/route");
const conversations = await import("@/app/api/v1/conversations/route");
const conversation = await import("@/app/api/v1/conversations/[id]/route");
const convMessages = await import("@/app/api/v1/conversations/[id]/messages/route");
const broadcast = await import("@/app/api/v1/broadcasts/[id]/route");
const webhooks = await import("@/app/api/v1/webhooks/route");
const webhook = await import("@/app/api/v1/webhooks/[id]/route");
const me = await import("@/app/api/v1/me/route");

function req(path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`https://crm.example.com${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${KEY_A}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => (await res.json()) as { data?: unknown; error?: { code: string } };
const ids = (body: { data?: unknown }) => (body.data as { id: string }[]).map((r) => r.id);

beforeEach(seed);

describe("account A cannot reach account B", () => {
  it("/me reports account A", async () => {
    const body = await json(await me.GET(req("/api/v1/me")));
    expect(body.data).toMatchObject({ account: { id: A, name: "Conta A" } });
  });

  it("contact lists hold only A's contacts", async () => {
    const body = await json(await contacts.GET(req("/api/v1/contacts")));
    expect(ids(body)).toEqual([ID.contactA]);
  });

  it("reading B's contact is a 404", async () => {
    const res = await contact.GET(req(`/api/v1/contacts/${ID.contactB}`), params(ID.contactB));
    expect(res.status).toBe(404);
  });

  it("patching B's contact is a 404 and leaves it untouched", async () => {
    const res = await contact.PATCH(
      req(`/api/v1/contacts/${ID.contactB}`, { method: "PATCH", body: { name: "invadido" } }),
      params(ID.contactB),
    );
    expect(res.status).toBe(404);
    expect(fake.tables.contacts.find((c) => c.id === ID.contactB)?.name).toBe("Bruno");
  });

  it("conversation lists hold only A's conversations", async () => {
    const body = await json(await conversations.GET(req("/api/v1/conversations")));
    expect(ids(body)).toEqual([ID.convA]);
  });

  it("reading B's conversation is a 404", async () => {
    const res = await conversation.GET(req(`/api/v1/conversations/${ID.convB}`), params(ID.convB));
    expect(res.status).toBe(404);
  });

  it("listing B's messages is a 404", async () => {
    const res = await convMessages.GET(req(`/api/v1/conversations/${ID.convB}/messages`), params(ID.convB));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("segredo B");
  });

  it("A still lists its own messages", async () => {
    const res = await convMessages.GET(req(`/api/v1/conversations/${ID.convA}/messages`), params(ID.convA));
    expect(res.status).toBe(200);
    expect(ids(await json(res))).toEqual(["m-a"]);
  });

  it("reading B's broadcast is a 404", async () => {
    const res = await broadcast.GET(req(`/api/v1/broadcasts/${ID.broadcastB}`), params(ID.broadcastB));
    expect(res.status).toBe(404);
  });

  it("webhook lists hold only A's endpoints", async () => {
    const body = await json(await webhooks.GET(req("/api/v1/webhooks")));
    expect(ids(body)).toEqual([ID.hookA]);
  });

  it("B's webhook cannot be read, changed or deleted", async () => {
    expect((await webhook.GET(req(`/api/v1/webhooks/${ID.hookB}`), params(ID.hookB))).status).toBe(404);
    const patched = await webhook.PATCH(
      req(`/api/v1/webhooks/${ID.hookB}`, { method: "PATCH", body: { url: "https://evil.example/x" } }),
      params(ID.hookB),
    );
    expect(patched.status).toBe(404);
    expect((await webhook.DELETE(req(`/api/v1/webhooks/${ID.hookB}`, { method: "DELETE" }), params(ID.hookB))).status).toBe(404);
    const hookB = fake.tables.webhook_endpoints.find((h) => h.id === ID.hookB);
    expect(hookB?.url).toBe("https://b.example/h");
  });

  it("a webhook created with a forged account_id lands in A", async () => {
    const res = await webhooks.POST(
      req("/api/v1/webhooks", {
        method: "POST",
        body: { url: "https://a.example/new", events: ["message.received"], account_id: B },
      }),
    );
    expect(res.status).toBe(201);
    const created = fake.tables.webhook_endpoints.find((h) => h.url === "https://a.example/new");
    expect(created?.account_id).toBe(A);
  });

  it("every call is logged against account A", async () => {
    await contacts.GET(req("/api/v1/contacts"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.tables.api_request_log.length).toBeGreaterThan(0);
    expect(fake.tables.api_request_log.every((r) => r.account_id === A)).toBe(true);
  });
});
