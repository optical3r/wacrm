// ============================================================
// Phase 4 isolation: flows, automations, groups, sending into a chat,
// notifications and reports. Account A's key against account B's rows
// must behave as if they did not exist, and never change them.
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
  groupContactA: "a1000000-0000-4000-8000-000000000002",
  groupContactB: "b1000000-0000-4000-8000-000000000002",
  convA: "a2000000-0000-4000-8000-000000000001",
  convB: "b2000000-0000-4000-8000-000000000001",
  groupA: "a2000000-0000-4000-8000-000000000002",
  groupB: "b2000000-0000-4000-8000-000000000002",
  flowA: "a3000000-0000-4000-8000-000000000001",
  flowB: "b3000000-0000-4000-8000-000000000001",
  runA: "a4000000-0000-4000-8000-000000000001",
  runB: "b4000000-0000-4000-8000-000000000001",
  autoA: "a5000000-0000-4000-8000-000000000001",
  autoB: "b5000000-0000-4000-8000-000000000001",
  notifA: "a6000000-0000-4000-8000-000000000001",
  notifB: "b6000000-0000-4000-8000-000000000001",
  notifUaInB: "b6000000-0000-4000-8000-000000000002",
};
const NOW = new Date().toISOString();

let fake: ReturnType<typeof createFakeSupabase>;

function seed(planA: "pro" | "starter" = "starter") {
  fake = createFakeSupabase({
    accounts: [
      { id: A, plan: planA, status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_A },
      { id: B, plan: "starter", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_B },
    ],
    account_memberships: [
      { account_id: A, user_id: U_A, role: "owner" },
      { account_id: B, user_id: U_B, role: "owner" },
      { account_id: B, user_id: U_A, role: "agent" },
    ],
    contacts: [
      { id: ID.contactA, account_id: A, phone: "+5511900000001", name: "Ana", is_group: false, created_at: NOW },
      { id: ID.contactB, account_id: B, phone: "+5511900000002", name: "Bruno", is_group: false, created_at: NOW },
      { id: ID.groupContactA, account_id: A, name: "Grupo A", is_group: true, group_hidden_at: null },
      { id: ID.groupContactB, account_id: B, name: "Grupo B", is_group: true, group_hidden_at: null },
    ],
    conversations: [
      { id: ID.convA, account_id: A, contact_id: ID.contactA, status: "open", owner_ids: [U_A], is_group: false, created_at: NOW },
      { id: ID.convB, account_id: B, contact_id: ID.contactB, status: "open", owner_ids: [], is_group: false, created_at: NOW },
      { id: ID.groupA, account_id: A, contact_id: ID.groupContactA, status: "open", owner_ids: [], is_group: true, created_at: NOW },
      { id: ID.groupB, account_id: B, contact_id: ID.groupContactB, status: "open", owner_ids: [], is_group: true, created_at: NOW },
    ],
    flows: [
      { id: ID.flowA, account_id: A, name: "Boas-vindas A", status: "draft", trigger_type: "manual", trigger_config: {}, created_at: NOW },
      { id: ID.flowB, account_id: B, name: "Boas-vindas B", status: "active", trigger_type: "manual", trigger_config: {}, entry_node_id: "n1", created_at: NOW },
    ],
    flow_nodes: [{ id: "fn-b", flow_id: ID.flowB, node_key: "n1", node_type: "end", config: {} }],
    flow_runs: [
      { id: ID.runA, account_id: A, flow_id: ID.flowA, contact_id: ID.contactA, status: "active", started_at: NOW },
      { id: ID.runB, account_id: B, flow_id: ID.flowB, contact_id: ID.contactB, status: "active", started_at: NOW },
    ],
    automations: [
      { id: ID.autoA, account_id: A, name: "Auto A", trigger_type: "tag_added", trigger_config: {}, is_active: false, created_at: NOW },
      { id: ID.autoB, account_id: B, name: "Auto B", trigger_type: "tag_added", trigger_config: {}, is_active: true, created_at: NOW },
    ],
    automation_steps: [],
    automation_logs: [
      { id: "log-a", account_id: A, automation_id: ID.autoA, status: "success", created_at: NOW },
      { id: "log-b", account_id: B, automation_id: ID.autoB, status: "success", created_at: NOW },
    ],
    notifications: [
      { id: ID.notifA, account_id: A, user_id: U_A, type: "conversation_assigned", title: "A", read_at: null, created_at: NOW },
      { id: ID.notifB, account_id: B, user_id: U_B, type: "conversation_assigned", title: "B", read_at: null, created_at: NOW },
      { id: ID.notifUaInB, account_id: B, user_id: U_A, type: "conversation_assigned", title: "A em B", read_at: null, created_at: NOW },
    ],
    deals: [
      { id: "deal-a", account_id: A, status: "open", value: 10, created_at: NOW, updated_at: NOW },
      { id: "deal-b", account_id: B, status: "open", value: 999, created_at: NOW, updated_at: NOW },
    ],
    broadcasts: [],
    messages: [],
    api_request_log: [],
  });
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fake }));
vi.mock("@/lib/automations/admin-client", () => ({ supabaseAdmin: () => fake }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => {} }));
const send = vi.fn(async () => ({ messageId: "m1", whatsappMessageId: "w1" }));
vi.mock("@/lib/whatsapp/send-message", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/send-message")>()),
  sendMessageToConversation: (...a: unknown[]) => send(...(a as [])),
}));

const KEY_A = generateApiKey().plaintext;
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: async (hash: string) =>
    hash === hashApiKey(KEY_A)
      ? { id: "key-a", account_id: A, created_by: U_A, name: "A", scopes: [...API_SCOPES], expires_at: null, revoked_at: null }
      : null,
  touchLastUsed: () => {},
  getAccountName: async () => "Conta A",
}));

const flows = await import("@/app/api/v1/flows/route");
const flow = await import("@/app/api/v1/flows/[id]/route");
const flowStatus = await import("@/app/api/v1/flows/[id]/status/route");
const flowRuns = await import("@/app/api/v1/flows/[id]/runs/route");
const flowStart = await import("@/app/api/v1/flows/[id]/start/route");
const runStop = await import("@/app/api/v1/flow-runs/[id]/stop/route");
const automations = await import("@/app/api/v1/automations/route");
const automation = await import("@/app/api/v1/automations/[id]/route");
const automationLogs = await import("@/app/api/v1/automations/[id]/logs/route");
const groups = await import("@/app/api/v1/groups/route");
const group = await import("@/app/api/v1/groups/[id]/route");
const convMessages = await import("@/app/api/v1/conversations/[id]/messages/route");
const notifications = await import("@/app/api/v1/notifications/route");
const notificationsRead = await import("@/app/api/v1/notifications/read/route");
const summary = await import("@/app/api/v1/reports/summary/route");

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
  send.mockClear();
});

describe("flows", () => {
  it("lists and reads only A's", async () => {
    expect(ids((await json(await flows.GET(req("/api/v1/flows")))).data)).toEqual([ID.flowA]);
    expect((await flow.GET(req(`/api/v1/flows/${ID.flowB}`), p({ id: ID.flowB }))).status).toBe(404);
    expect((await flowRuns.GET(req(`/api/v1/flows/${ID.flowB}/runs`), p({ id: ID.flowB }))).status).toBe(404);
    const runs = await json(await flowRuns.GET(req(`/api/v1/flows/${ID.flowA}/runs`), p({ id: ID.flowA })));
    expect(ids(runs.data)).toEqual([ID.runA]);
  });

  it("B's flow cannot be switched off or started", async () => {
    const res = await flowStatus.POST(
      req(`/api/v1/flows/${ID.flowB}/status`, { method: "POST", body: { status: "archived" } }),
      p({ id: ID.flowB })
    );
    expect(res.status).toBe(404);
    expect(row("flows", ID.flowB)?.status).toBe("active");

    const started = await flowStart.POST(
      req(`/api/v1/flows/${ID.flowB}/start`, { method: "POST", body: { conversation_id: ID.convA } }),
      p({ id: ID.flowB })
    );
    expect(started.status).toBe(404);
    expect(fake.tables.flow_runs).toHaveLength(2);
  });

  it("A's flow cannot start on B's conversation, nor on a group", async () => {
    for (const conv of [ID.convB, ID.groupA]) {
      const res = await flowStart.POST(
        req(`/api/v1/flows/${ID.flowA}/start`, { method: "POST", body: { conversation_id: conv } }),
        p({ id: ID.flowA })
      );
      expect([400, 404]).toContain(res.status);
    }
    expect(fake.tables.flow_runs).toHaveLength(2);
  });

  it("B's run cannot be stopped; A's can", async () => {
    expect((await runStop.POST(req(`/api/v1/flow-runs/${ID.runB}/stop`, { method: "POST" }), p({ id: ID.runB }))).status).toBe(404);
    expect(row("flow_runs", ID.runB)?.status).toBe("active");
    const res = await runStop.POST(req(`/api/v1/flow-runs/${ID.runA}/stop`, { method: "POST" }), p({ id: ID.runA }));
    expect(res.status).toBe(200);
    expect(row("flow_runs", ID.runA)?.status).toBe("paused_by_agent");
  });

  it("archiving A's flow works", async () => {
    const res = await flowStatus.POST(
      req(`/api/v1/flows/${ID.flowA}/status`, { method: "POST", body: { status: "archived" } }),
      p({ id: ID.flowA })
    );
    expect(res.status).toBe(200);
    expect(row("flows", ID.flowA)?.status).toBe("archived");
  });
});

describe("automations", () => {
  it("lists, reads and logs only A's", async () => {
    expect(ids((await json(await automations.GET(req("/api/v1/automations")))).data)).toEqual([ID.autoA]);
    expect((await automation.GET(req(`/api/v1/automations/${ID.autoB}`), p({ id: ID.autoB }))).status).toBe(404);
    expect((await automationLogs.GET(req(`/api/v1/automations/${ID.autoB}/logs`), p({ id: ID.autoB }))).status).toBe(404);
    const logs = await json(await automationLogs.GET(req(`/api/v1/automations/${ID.autoA}/logs`), p({ id: ID.autoA })));
    expect(ids(logs.data)).toEqual(["log-a"]);
  });

  it("B's automation cannot be switched off", async () => {
    const res = await automation.PATCH(
      req(`/api/v1/automations/${ID.autoB}`, { method: "PATCH", body: { is_active: false } }),
      p({ id: ID.autoB })
    );
    expect(res.status).toBe(404);
    expect(row("automations", ID.autoB)?.is_active).toBe(true);
  });

  it("turning on an automation with no steps is refused", async () => {
    const res = await automation.PATCH(
      req(`/api/v1/automations/${ID.autoA}`, { method: "PATCH", body: { is_active: true } }),
      p({ id: ID.autoA })
    );
    expect(res.status).toBe(400);
    expect(row("automations", ID.autoA)?.is_active).toBe(false);
  });
});

describe("groups (Starter)", () => {
  it("lists only A's groups and cannot hide B's", async () => {
    expect(ids((await json(await groups.GET(req("/api/v1/groups")))).data)).toEqual([ID.groupA]);
    const res = await group.PATCH(
      req(`/api/v1/groups/${ID.groupB}`, { method: "PATCH", body: { hidden: true } }),
      p({ id: ID.groupB })
    );
    expect(res.status).toBe(404);
    expect(row("contacts", ID.groupContactB)?.group_hidden_at).toBeNull();
    const own = await group.PATCH(
      req(`/api/v1/groups/${ID.groupA}`, { method: "PATCH", body: { hidden: true } }),
      p({ id: ID.groupA })
    );
    expect(own.status).toBe(200);
    expect(row("contacts", ID.groupContactA)?.group_hidden_at).toBeTruthy();
  });

  it("are refused on the Pro plan", async () => {
    seed("pro");
    expect((await groups.GET(req("/api/v1/groups"))).status).toBe(403);
  });
});

describe("sending into a conversation", () => {
  it("cannot send into B's conversation or group", async () => {
    for (const conv of [ID.convB, ID.groupB]) {
      const res = await convMessages.POST(
        req(`/api/v1/conversations/${conv}/messages`, { method: "POST", body: { type: "text", text: "oi" } }),
        p({ id: conv })
      );
      expect(res.status).toBe(404);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("sends into A's own group on Starter, and refuses groups on Pro", async () => {
    const res = await convMessages.POST(
      req(`/api/v1/conversations/${ID.groupA}/messages`, { method: "POST", body: { type: "text", text: "oi" } }),
      p({ id: ID.groupA })
    );
    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[])[1]).toBe(A);

    seed("pro");
    const pro = await convMessages.POST(
      req(`/api/v1/conversations/${ID.groupA}/messages`, { method: "POST", body: { type: "text", text: "oi" } }),
      p({ id: ID.groupA })
    );
    expect(pro.status).toBe(403);
  });
});

describe("notifications", () => {
  it("shows the key creator's notifications in A only, even when they also belong to B", async () => {
    expect(ids((await json(await notifications.GET(req("/api/v1/notifications")))).data)).toEqual([ID.notifA]);
  });

  it("marking all read touches only A's", async () => {
    const res = await notificationsRead.POST(req("/api/v1/notifications/read", { method: "POST", body: {} }));
    expect((await json(res)).data.marked).toBe(1);
    expect(row("notifications", ID.notifA)?.read_at).toBeTruthy();
    expect(row("notifications", ID.notifB)?.read_at).toBeNull();
    expect(row("notifications", ID.notifUaInB)?.read_at).toBeNull();
  });

  it("naming B's ids marks nothing", async () => {
    const res = await notificationsRead.POST(
      req("/api/v1/notifications/read", { method: "POST", body: { ids: [ID.notifB, ID.notifUaInB] } })
    );
    expect((await json(res)).data.marked).toBe(0);
  });
});

describe("reports", () => {
  it("counts only A's rows and leaves groups out", async () => {
    const { data } = await json(await summary.GET(req("/api/v1/reports/summary?days=7")));
    expect(data.conversations.open).toBe(1);
    expect(data.conversations.open_by_owner).toEqual({ [U_A]: 1 });
    expect(data.contacts.total).toBe(1);
    expect(data.deals.open).toEqual({ count: 1, value: 10 });
    expect(data.flows.runs_started).toBe(1);
  });
});
