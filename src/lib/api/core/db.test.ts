import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAccountDb, isUuid } from "./db";
import { ApiError } from "@/lib/api/v1/respond";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Records every builder call so tests can assert the filters applied. */
function recorder(rows: Record<string, Record<string, unknown>[]> = {}) {
  const calls: { table: string; op: string; args: unknown[] }[][] = [];
  const admin = {
    from(table: string) {
      const chain: { table: string; op: string; args: unknown[] }[] = [];
      calls.push(chain);
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {};
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          chain.push({ table, op, args });
          if (op === "eq") filters.push([args[0] as string, args[1]]);
          return b;
        };
      }
      b.maybeSingle = async () => {
        const hit = (rows[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v));
        return { data: hit ?? null, error: null };
      };
      return b;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

describe("createAccountDb", () => {
  it("rejects a non-uuid account id", () => {
    const { admin } = recorder();
    expect(() => createAccountDb(admin, "nope")).toThrow();
  });

  it("filters selects, updates and deletes by account_id", () => {
    const { admin, calls } = recorder();
    const db = createAccountDb(admin, A);
    db.from("contacts").select("id");
    db.from("contacts").update({ name: "x" });
    db.from("contacts").delete();
    for (const chain of calls) {
      expect(chain).toContainEqual({ table: "contacts", op: "eq", args: ["account_id", A] });
    }
  });

  it("stamps account_id on insert and ignores a caller-supplied one", () => {
    const { admin, calls } = recorder();
    createAccountDb(admin, A).from("tags").insert([{ name: "vip", account_id: B }]);
    expect(calls[0][0]).toEqual({ table: "tags", op: "insert", args: [[{ name: "vip", account_id: A }]] });
  });

  it("strips account_id from an update patch", () => {
    const { admin, calls } = recorder();
    createAccountDb(admin, A).from("tags").update({ name: "y", account_id: B });
    expect(calls[0][0].args[0]).toEqual({ name: "y" });
  });

  it("child() 404s when the parent belongs to another account", async () => {
    const { admin } = recorder({ conversations: [{ id: CONV_A, account_id: A }] });
    const dbB = createAccountDb(admin, B);
    const err = await dbB.child("messages", CONV_A).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("child() pins the foreign key when the parent is owned", async () => {
    const { admin, calls } = recorder({ conversations: [{ id: CONV_A, account_id: A }] });
    const msgs = await createAccountDb(admin, A).child("messages", CONV_A);
    msgs.select("*");
    msgs.insert({ body: "hi", conversation_id: "someone-else" });
    const after = calls.slice(1);
    expect(after[0]).toContainEqual({ table: "messages", op: "eq", args: ["conversation_id", CONV_A] });
    expect(after[1][0].args[0]).toEqual({ body: "hi", conversation_id: CONV_A });
  });

  it("owns() is false for a non-uuid without touching the database", async () => {
    const { admin, calls } = recorder();
    expect(await createAccountDb(admin, A).owns("contacts", "1 or 1=1")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("isUuid", () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid("x")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
