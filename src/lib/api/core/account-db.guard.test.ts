// ============================================================
// Guard: public-API routes and MCP code reach data only through the
// account-scoped db (src/lib/api/core/db.ts).
//
// Fails when a file under the guarded folders
//   - imports or calls the service-role client directly,
//   - uses a raw Supabase client (`ctx.supabase`, `createClient`), or
//   - hands `.trusted` to anything but a vetted core that takes the
//     accountId and scopes by it.
// Adding a vetted core = one entry in VETTED, after reviewing that it
// filters every query by the accountId it receives.
// ============================================================

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../..");
const GUARDED = ["src/app/api/v1", "src/app/api/mcp", "src/lib/mcp"];

const VETTED = [
  "resolveAuditUserId",
  "findOrCreateContact",
  "setContactTags",
  "getContactById",
  "resolveConversationByPhone",
  "sendMessageToConversation",
  "createBroadcast",
  "deliverBroadcast",
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = GUARDED.flatMap((d) => walk(join(ROOT, d)));

export function trustedMisuses(source: string): string[] {
  const out: string[] = [];
  const re = /\.trusted\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(Math.max(0, m.index - 120), m.index);
    // `<vetted>(\n   ctx.db` or `<vetted>(ctx.db`
    const call = before.match(/([A-Za-z_]\w*)\(\s*[\w.]*$/);
    if (!call || !VETTED.includes(call[1])) {
      out.push(source.slice(Math.max(0, m.index - 40), m.index + 8).replace(/\s+/g, " "));
    }
  }
  return out;
}

describe("account-scoped db guard", () => {
  it("finds the route files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const name = relative(ROOT, file);
    const source = readFileSync(file, "utf8");

    it(`${name} does not use the service-role client directly`, () => {
      expect(source).not.toMatch(/supabaseAdmin|flows\/admin-client|supabase\/admin/);
      expect(source).not.toMatch(/ctx\.supabase|createClient\(|createServiceClient/);
    });

    it(`${name} passes .trusted only to vetted cores`, () => {
      expect(trustedMisuses(source)).toEqual([]);
    });
  }

  it("flags .trusted used outside a vetted call", () => {
    expect(trustedMisuses("await ctx.db.trusted.from('contacts').select('*')")).toHaveLength(1);
    expect(trustedMisuses("await getContactById(ctx.db.trusted, ctx.accountId, id)")).toEqual([]);
  });
});
