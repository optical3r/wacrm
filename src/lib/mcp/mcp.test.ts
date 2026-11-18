// End-to-end over the real /api/mcp route on the in-memory database:
// JSON-RPC in, tool results out, scoped to the key's account.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey, hashApiKey } from "@/lib/api-keys/keys";
import { API_SCOPES } from "@/lib/api-keys/scopes";
import { createFakeSupabase } from "@/lib/api/core/__tests__/fake-supabase";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOOK_B = "b4000000-0000-4000-8000-000000000001";
const HOOK_A = "a4000000-0000-4000-8000-000000000001";

let fake: ReturnType<typeof createFakeSupabase>;
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fake }));

const KEY_READ = generateApiKey().plaintext;
const KEY_WRITE = generateApiKey().plaintext;
const KEY_OFF = generateApiKey().plaintext;
const keyRow = (id: string, extra: Record<string, unknown>) => ({
  id,
  account_id: A,
  created_by: "u-a",
  name: id,
  scopes: [...API_SCOPES],
  expires_at: null,
  revoked_at: null,
  ...extra,
});
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: async (hash: string) => {
    if (hash === hashApiKey(KEY_READ)) return keyRow("k-read", { mcp_enabled: true, mcp_allow_writes: false });
    if (hash === hashApiKey(KEY_WRITE)) return keyRow("k-write", { mcp_enabled: true, mcp_allow_writes: true });
    if (hash === hashApiKey(KEY_OFF)) return keyRow("k-off", { mcp_enabled: false });
    return null;
  },
  touchLastUsed: () => {},
  getAccountName: async () => "Conta A",
}));

const { POST } = await import("@/app/api/mcp/route");

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: A, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: "u-a" }],
    webhook_endpoints: [
      { id: HOOK_A, account_id: A, url: "https://a.example/h", events: ["message.received"], is_active: true },
      { id: HOOK_B, account_id: B, url: "https://b.example/h", events: ["message.received"], is_active: true },
    ],
    api_request_log: [],
  });
});

let rpcId = 0;
async function rpc(key: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await POST(
    new Request("https://crm.example.com/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const call = (key: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(key, "tools/call", { name, arguments: args });

describe("/api/mcp", () => {
  it("401s without a key", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
  });

  it("403s when the key has MCP off", async () => {
    expect((await rpc(KEY_OFF, "tools/list")).status).toBe(403);
  });

  it("initializes", async () => {
    const { body } = await rpc(KEY_READ, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(body.result.serverInfo.name).toBe("labcrm");
  });

  it("a read-only key lists only read tools", async () => {
    const { body } = await rpc(KEY_READ, "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_contacts");
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("delete_webhook");
  });

  it("a write key also lists write tools", async () => {
    const { body } = await rpc(KEY_WRITE, "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_contact", "send_message", "delete_webhook"]));
  });

  it("whoami answers for the key's account", async () => {
    const { body } = await call(KEY_READ, "whoami");
    expect(JSON.parse(body.result.content[0].text).account.id).toBe(A);
  });

  it("list_webhooks returns only the account's endpoints", async () => {
    const { body } = await call(KEY_READ, "list_webhooks");
    const data = JSON.parse(body.result.content[0].text).data;
    expect(data.map((h: { id: string }) => h.id)).toEqual([HOOK_A]);
  });

  it("destructive tools refuse without confirmar", async () => {
    const { body } = await call(KEY_WRITE, "delete_webhook", { id: HOOK_A });
    expect(body.result?.isError ?? body.error).toBeTruthy();
    expect(fake.tables.webhook_endpoints).toHaveLength(2);
  });

  it("deleting another account's webhook is a not-found, even confirmed", async () => {
    const { body } = await call(KEY_WRITE, "delete_webhook", { id: HOOK_B, confirmar: true });
    expect(body.result.isError).toBe(true);
    expect(fake.tables.webhook_endpoints.find((h) => h.id === HOOK_B)).toBeTruthy();
  });

  it("deletes its own webhook when confirmed, and logs via mcp", async () => {
    const { body } = await call(KEY_WRITE, "delete_webhook", { id: HOOK_A, confirmar: true });
    expect(body.result.isError).toBeFalsy();
    expect(fake.tables.webhook_endpoints.map((h) => h.id)).toEqual([HOOK_B]);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.tables.api_request_log).toContainEqual(
      expect.objectContaining({ via: "mcp", route: "mcp:delete_webhook", account_id: A, status: 200 }),
    );
  });
});
