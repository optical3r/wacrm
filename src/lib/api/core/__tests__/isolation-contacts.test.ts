// ============================================================
// Phase 2 isolation: tags, custom fields, notes, contact deletion and
// conversation changes. Account A's key against account B's rows must
// behave as if they did not exist, and never change them.
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
  convA: "a2000000-0000-4000-8000-000000000001",
  convB: "b2000000-0000-4000-8000-000000000001",
  tagA: "a5000000-0000-4000-8000-000000000001",
  tagB: "b5000000-0000-4000-8000-000000000001",
  fieldA: "a6000000-0000-4000-8000-000000000001",
  fieldB: "b6000000-0000-4000-8000-000000000001",
  noteB: "b7000000-0000-4000-8000-000000000001",
};

let fake: ReturnType<typeof createFakeSupabase>;

function seed() {
  fake = createFakeSupabase({
    accounts: [
      { id: A, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_A },
      { id: B, plan: "pro", status: "active", api_enabled: true, api_rate_limit: null, owner_user_id: U_B },
    ],
    account_memberships: [
      { account_id: A, user_id: U_A, role: "owner" },
      { account_id: B, user_id: U_B, role: "owner" },
    ],
    contacts: [
      { id: ID.contactA, account_id: A, phone: "+5511900000001", name: "Ana", is_group: false },
      { id: ID.contactB, account_id: B, phone: "+5511900000002", name: "Bruno", is_group: false },
    ],
    conversations: [
      { id: ID.convA, account_id: A, contact_id: ID.contactA, status: "open", owner_ids: [], channel_ids: [], unread_count: 2, is_group: false },
      { id: ID.convB, account_id: B, contact_id: ID.contactB, status: "open", owner_ids: [U_B], channel_ids: [], unread_count: 3, is_group: false },
    ],
    tags: [
      { id: ID.tagA, account_id: A, name: "vip", color: "#111111" },
      { id: ID.tagB, account_id: B, name: "segredo", color: "#222222" },
    ],
    contact_tags: [{ id: "ct-b", contact_id: ID.contactB, tag_id: ID.tagB }],
    custom_fields: [
      { id: ID.fieldA, account_id: A, field_name: "Cidade", field_type: "text" },
      { id: ID.fieldB, account_id: B, field_name: "CPF", field_type: "text" },
    ],
    contact_custom_values: [{ id: "cv-b", contact_id: ID.contactB, custom_field_id: ID.fieldB, value: "123" }],
    contact_notes: [{ id: ID.noteB, account_id: B, contact_id: ID.contactB, user_id: U_B, note_text: "nota B" }],
    whatsapp_config: [],
    api_request_log: [],
  });
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fake }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => {} }));
const markRead = vi.fn(async () => 1);
vi.mock("@/lib/whatsapp/mark-read", () => ({ markConversationReadOnWhatsApp: (...a: unknown[]) => markRead(...(a as [])) }));

const KEY_A = generateApiKey().plaintext;
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: async (hash: string) =>
    hash === hashApiKey(KEY_A)
      ? { id: "key-a", account_id: A, created_by: U_A, name: "A", scopes: [...API_SCOPES], expires_at: null, revoked_at: null }
      : null,
  touchLastUsed: () => {},
  getAccountName: async () => "Conta A",
}));

const contact = await import("@/app/api/v1/contacts/[id]/route");
const contactTags = await import("@/app/api/v1/contacts/[id]/tags/route");
const contactTag = await import("@/app/api/v1/contacts/[id]/tags/[tagId]/route");
const contactFields = await import("@/app/api/v1/contacts/[id]/fields/route");
const contactNotes = await import("@/app/api/v1/contacts/[id]/notes/route");
const tags = await import("@/app/api/v1/tags/route");
const tag = await import("@/app/api/v1/tags/[id]/route");
const fields = await import("@/app/api/v1/fields/route");
const field = await import("@/app/api/v1/fields/[id]/route");
const note = await import("@/app/api/v1/notes/[id]/route");
const conversations = await import("@/app/api/v1/conversations/route");
const conversation = await import("@/app/api/v1/conversations/[id]/route");
const conversationRead = await import("@/app/api/v1/conversations/[id]/read/route");

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

beforeEach(() => {
  seed();
  markRead.mockClear();
});

describe("tags", () => {
  it("lists only A's tags", async () => {
    const body = await json(await tags.GET(req("/api/v1/tags")));
    expect(body.data.map((t: { id: string }) => t.id)).toEqual([ID.tagA]);
  });

  it("B's tag cannot be read, renamed or deleted", async () => {
    expect((await tag.GET(req(`/api/v1/tags/${ID.tagB}`), p({ id: ID.tagB }))).status).toBe(404);
    const patched = await tag.PATCH(req(`/api/v1/tags/${ID.tagB}`, { method: "PATCH", body: { name: "x" } }), p({ id: ID.tagB }));
    expect(patched.status).toBe(404);
    expect((await tag.DELETE(req(`/api/v1/tags/${ID.tagB}`, { method: "DELETE" }), p({ id: ID.tagB }))).status).toBe(404);
    expect(row("tags", ID.tagB)?.name).toBe("segredo");
  });

  it("creating a tag with B's name creates a new one in A", async () => {
    const res = await tags.POST(req("/api/v1/tags", { method: "POST", body: { name: "segredo", account_id: B } }));
    expect(res.status).toBe(201);
    const created = fake.tables.tags.filter((t) => t.name === "segredo");
    expect(created.map((t) => t.account_id).sort()).toEqual([A, B].sort());
  });

  it("an existing name returns the same tag", async () => {
    const res = await tags.POST(req("/api/v1/tags", { method: "POST", body: { name: "VIP" } }));
    expect(res.status).toBe(200);
    expect((await json(res)).data.id).toBe(ID.tagA);
  });

  it("A cannot tag B's contact, nor put B's tag on its own contact", async () => {
    const onB = await contactTags.POST(
      req(`/api/v1/contacts/${ID.contactB}/tags`, { method: "POST", body: { tag_id: ID.tagA } }),
      p({ id: ID.contactB }),
    );
    expect(onB.status).toBe(404);
    const withB = await contactTags.POST(
      req(`/api/v1/contacts/${ID.contactA}/tags`, { method: "POST", body: { tag_id: ID.tagB } }),
      p({ id: ID.contactA }),
    );
    expect(withB.status).toBe(404);
    expect(fake.tables.contact_tags).toHaveLength(1);
  });

  it("A tags its own contact by name", async () => {
    const res = await contactTags.POST(
      req(`/api/v1/contacts/${ID.contactA}/tags`, { method: "POST", body: { names: ["vip", "novo"] } }),
      p({ id: ID.contactA }),
    );
    expect(res.status).toBe(200);
    const mine = fake.tables.contact_tags.filter((j) => j.contact_id === ID.contactA);
    expect(mine).toHaveLength(2);
    const novo = fake.tables.tags.find((t) => t.name === "novo");
    expect(novo?.account_id).toBe(A);
  });

  it("reading or untagging B's contact is a 404", async () => {
    expect((await contactTags.GET(req(`/api/v1/contacts/${ID.contactB}/tags`), p({ id: ID.contactB }))).status).toBe(404);
    const res = await contactTag.DELETE(
      req(`/api/v1/contacts/${ID.contactB}/tags/${ID.tagB}`, { method: "DELETE" }),
      p({ id: ID.contactB, tagId: ID.tagB }),
    );
    expect(res.status).toBe(404);
    expect(fake.tables.contact_tags).toHaveLength(1);
  });
});

describe("custom fields", () => {
  it("lists only A's fields", async () => {
    const body = await json(await fields.GET(req("/api/v1/fields")));
    expect(body.data.map((f: { id: string }) => f.id)).toEqual([ID.fieldA]);
  });

  it("B's field cannot be renamed or deleted", async () => {
    const res = await field.PATCH(req(`/api/v1/fields/${ID.fieldB}`, { method: "PATCH", body: { name: "x" } }), p({ id: ID.fieldB }));
    expect(res.status).toBe(404);
    expect((await field.DELETE(req(`/api/v1/fields/${ID.fieldB}`, { method: "DELETE" }), p({ id: ID.fieldB }))).status).toBe(404);
    expect(row("custom_fields", ID.fieldB)?.field_name).toBe("CPF");
  });

  it("B's contact values are unreachable", async () => {
    const res = await contactFields.GET(req(`/api/v1/contacts/${ID.contactB}/fields`), p({ id: ID.contactB }));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("123");
  });

  it("writing B's field on A's contact is refused", async () => {
    const res = await contactFields.PUT(
      req(`/api/v1/contacts/${ID.contactA}/fields`, { method: "PUT", body: { values: { [ID.fieldB]: "x" } } }),
      p({ id: ID.contactA }),
    );
    expect(res.status).toBe(404);
    expect(fake.tables.contact_custom_values).toHaveLength(1);
  });

  it("writing on B's contact is refused", async () => {
    const res = await contactFields.PUT(
      req(`/api/v1/contacts/${ID.contactB}/fields`, { method: "PUT", body: { values: { [ID.fieldA]: "x" } } }),
      p({ id: ID.contactB }),
    );
    expect(res.status).toBe(404);
    expect(fake.tables.contact_custom_values).toHaveLength(1);
  });

  it("A sets, updates and clears its own value", async () => {
    const put = (value: string | null) =>
      contactFields.PUT(
        req(`/api/v1/contacts/${ID.contactA}/fields`, { method: "PUT", body: { values: { [ID.fieldA]: value } } }),
        p({ id: ID.contactA }),
      );
    expect((await put("Salvador")).status).toBe(200);
    expect((await put("Recife")).status).toBe(200);
    const mine = fake.tables.contact_custom_values.filter((v) => v.contact_id === ID.contactA);
    expect(mine.map((v) => v.value)).toEqual(["Recife"]);
    await put(null);
    expect(fake.tables.contact_custom_values.filter((v) => v.contact_id === ID.contactA)).toHaveLength(0);
  });
});

describe("notes", () => {
  it("B's notes cannot be listed, edited or deleted", async () => {
    expect((await contactNotes.GET(req(`/api/v1/contacts/${ID.contactB}/notes`), p({ id: ID.contactB }))).status).toBe(404);
    const res = await note.PATCH(req(`/api/v1/notes/${ID.noteB}`, { method: "PATCH", body: { text: "x" } }), p({ id: ID.noteB }));
    expect(res.status).toBe(404);
    expect((await note.DELETE(req(`/api/v1/notes/${ID.noteB}`, { method: "DELETE" }), p({ id: ID.noteB }))).status).toBe(404);
    expect(row("contact_notes", ID.noteB)?.note_text).toBe("nota B");
  });

  it("A cannot write a note on B's contact", async () => {
    const res = await contactNotes.POST(
      req(`/api/v1/contacts/${ID.contactB}/notes`, { method: "POST", body: { text: "oi" } }),
      p({ id: ID.contactB }),
    );
    expect(res.status).toBe(404);
    expect(fake.tables.contact_notes).toHaveLength(1);
  });

  it("A writes a note on its own contact, stamped with A", async () => {
    const res = await contactNotes.POST(
      req(`/api/v1/contacts/${ID.contactA}/notes`, { method: "POST", body: { text: "ligar amanhã" } }),
      p({ id: ID.contactA }),
    );
    expect(res.status).toBe(201);
    expect(fake.tables.contact_notes.find((n) => n.note_text === "ligar amanhã")?.account_id).toBe(A);
  });
});

describe("contacts", () => {
  it("deleting B's contact is a 404 and keeps it", async () => {
    const res = await contact.DELETE(req(`/api/v1/contacts/${ID.contactB}`, { method: "DELETE" }), p({ id: ID.contactB }));
    expect(res.status).toBe(404);
    expect(row("contacts", ID.contactB)).toBeTruthy();
  });
});

describe("conversations", () => {
  it("filters by unread and unassigned stay inside A", async () => {
    const unread = await json(await conversations.GET(req("/api/v1/conversations?unread=true")));
    expect(unread.data.map((c: { id: string }) => c.id)).toEqual([ID.convA]);
    const free = await json(await conversations.GET(req("/api/v1/conversations?unassigned=true")));
    expect(free.data.map((c: { id: string }) => c.id)).toEqual([ID.convA]);
    const byOwnerB = await json(await conversations.GET(req(`/api/v1/conversations?owner_id=${U_B}`)));
    expect(byOwnerB.data).toEqual([]);
  });

  it("B's conversation cannot be changed or marked read", async () => {
    const res = await conversation.PATCH(
      req(`/api/v1/conversations/${ID.convB}`, { method: "PATCH", body: { status: "closed" } }),
      p({ id: ID.convB }),
    );
    expect(res.status).toBe(404);
    expect((await conversationRead.POST(req(`/api/v1/conversations/${ID.convB}/read`, { method: "POST" }), p({ id: ID.convB }))).status).toBe(404);
    expect(row("conversations", ID.convB)).toMatchObject({ status: "open", unread_count: 3 });
    expect(markRead).not.toHaveBeenCalled();
  });

  it("a member of B cannot be made owner of A's lead", async () => {
    const res = await conversation.PATCH(
      req(`/api/v1/conversations/${ID.convA}`, { method: "PATCH", body: { owner_ids: [U_B] } }),
      p({ id: ID.convA }),
    );
    expect(res.status).toBe(400);
    expect(row("conversations", ID.convA)?.owner_ids).toEqual([]);
  });

  it("A closes its conversation, sets an owner and marks it read", async () => {
    const res = await conversation.PATCH(
      req(`/api/v1/conversations/${ID.convA}`, { method: "PATCH", body: { status: "closed", owner_ids: [U_A] } }),
      p({ id: ID.convA }),
    );
    expect(res.status).toBe(200);
    expect(row("conversations", ID.convA)).toMatchObject({ status: "closed", owner_ids: [U_A] });
    const read = await conversationRead.POST(req(`/api/v1/conversations/${ID.convA}/read`, { method: "POST" }), p({ id: ID.convA }));
    expect(read.status).toBe(200);
    expect(row("conversations", ID.convA)?.unread_count).toBe(0);
    expect(markRead).toHaveBeenCalledWith(expect.anything(), A, ID.convA);
  });
});
