// ============================================================
// Minimal in-memory stand-in for the service-role Supabase client,
// enough for the account-isolation tests: from/select/insert/update/
// delete with eq/neq/in/is/order/limit/range and maybeSingle/single.
// Embeds in a select (`contact_tags(tags(*))`) and `.or()` are ignored:
// the tests assert WHICH rows come back, not their shape.
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export function createFakeSupabase(tables: Record<string, Row[]>) {
  const tableRows = (t: string) => (tables[t] ??= []);

  function builder(table: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let returning = false;
    const filters: ((r: Row) => boolean)[] = [];
    let limitN: number | null = null;

    const run = () => {
      const all = tableRows(table);
      if (op === "insert") {
        const inserted = payload.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
        all.push(...inserted);
        return inserted;
      }
      let hit = all.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        hit.forEach((r) => Object.assign(r, patch));
      } else if (op === "delete") {
        tables[table] = all.filter((r) => !hit.includes(r));
      }
      if (limitN !== null) hit = hit.slice(0, limitN);
      return hit.map((r) => ({ ...r }));
    };

    const b: any = {
      select(_cols?: string) {
        if (op !== "select") returning = true;
        return b;
      },
      insert(rows: Row | Row[]) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return b;
      },
      upsert(rows: Row | Row[]) {
        return b.insert(rows);
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq(col: string, val: unknown) {
        // `tag_filter.tag_id` style embedded filters are ignored.
        if (!col.includes(".")) filters.push((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (r[col] ?? null) === val);
        return b;
      },
      or() {
        return b;
      },
      ilike() {
        return b;
      },
      order() {
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      range(from: number, to: number) {
        limitN = to - from + 1;
        return b;
      },
      async maybeSingle() {
        const rows = run();
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = run();
        return rows[0]
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "no rows", code: "PGRST116" } };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          const rows = run();
          const data = op === "select" || returning ? rows : null;
          return Promise.resolve({ data, error: null, count: rows.length }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return b;
  }

  return {
    tables,
    from: (t: string) => builder(t),
    rpc: async (fn: string) =>
      fn === "api_rate_hit"
        ? { data: [{ allowed: true, remaining: 999, reset_at: new Date(Date.now() + 60_000).toISOString() }], error: null }
        : { data: null, error: { message: `rpc ${fn} not faked` } },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
