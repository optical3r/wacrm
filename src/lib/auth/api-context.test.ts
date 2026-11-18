import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError, ok } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

// ---- fake service-role client ----------------------------------------
let accountRow: Record<string, unknown> | null;
let rateRow: { allowed: boolean; remaining: number; reset_at: string } | null;
let rateError: { message: string } | null;
const logged: Record<string, unknown>[] = [];

function fakeAdmin() {
  return {
    from(table: string) {
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: accountRow, error: null }),
            }),
          }),
        };
      }
      if (table === "api_request_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            logged.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async () => ({ data: rateRow ? [rateRow] : null, error: rateError }),
  };
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fakeAdmin() }));

const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

const { authenticateApi, apiRoute, requirePlan, PLAN_RATE_LIMITS } = await import("./api-context");

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: ACCOUNT,
    created_by: "user-1",
    name: "Test key",
    scopes: ["messages:send"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
  accountRow = { plan: "pro", status: "active", api_enabled: true, api_rate_limit: null };
  rateRow = { allowed: true, remaining: 10, reset_at: new Date(Date.now() + 60_000).toISOString() };
  rateError = null;
  logged.length = 0;
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  expect((err as ApiError).status).toBe(status);
}

describe("authenticateApi", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(authenticateApi(reqWith()), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a key", async () => {
    await expectApiError(authenticateApi(reqWith("Bearer some-invite-token")), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(authenticateApi(reqWith(`Bearer ${KEY}`)), "unauthorized", 401);
  });

  it("returns an account-scoped context for a valid key", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ mcp_allow_writes: true }));
    const ctx = await authenticateApi(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.db.accountId).toBe(ACCOUNT);
    expect(ctx.plan).toBe("pro");
    expect(ctx.mcp).toEqual({ enabled: true, allowWrites: true });
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await authenticateApi(reqWith(KEY));
    expect(ctx.accountId).toBe(ACCOUNT);
  });

  it("403s when the account's API switch is off", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    accountRow = { plan: "pro", status: "active", api_enabled: false, api_rate_limit: null };
    await expectApiError(authenticateApi(reqWith(KEY)), "forbidden", 403);
  });

  it("403s when the account is not active", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    accountRow = { plan: "pro", status: "suspended", api_enabled: true, api_rate_limit: null };
    await expectApiError(authenticateApi(reqWith(KEY)), "forbidden", 403);
  });

  it("429s when the shared counter says no", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    rateRow = { allowed: false, remaining: 0, reset_at: new Date(Date.now() + 30_000).toISOString() };
    await expectApiError(authenticateApi(reqWith(KEY)), "rate_limited", 429);
  });

  it("falls back to the in-memory limiter at the plan budget when the RPC fails", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    accountRow = { plan: "starter", status: "active", api_enabled: true, api_rate_limit: null };
    rateError = { message: "function missing" };
    for (let i = 0; i < PLAN_RATE_LIMITS.starter; i++) {
      await authenticateApi(reqWith(KEY));
    }
    await expectApiError(authenticateApi(reqWith(KEY)), "rate_limited", 429);
  });
});

describe("requirePlan", () => {
  it("403s on the other plan", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    accountRow = { plan: "starter", status: "active", api_enabled: true, api_rate_limit: null };
    const ctx = await authenticateApi(reqWith(KEY));
    expect(() => requirePlan(ctx, "pro", "Modelos")).toThrow(ApiError);
    expect(() => requirePlan(ctx, "starter", "Grupos")).not.toThrow();
  });
});

describe("apiRoute", () => {
  it("403s when the key lacks the route's scope and logs the call", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["contacts:read"] }));
    const handler = vi.fn(async () => ok({}));
    const res = await apiRoute("messages:send", handler)(reqWith(KEY));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(logged[0]).toMatchObject({ account_id: ACCOUNT, status: 403, via: "api", route: "/api/v1/me" });
  });

  it("passes awaited params to the handler", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const route = apiRoute<{ id: string }>(null, async (_ctx, _req, { id }) => ok({ id }));
    const res = await route(reqWith(KEY), { params: Promise.resolve({ id: "abc" }) });
    expect(await res.json()).toEqual({ data: { id: "abc" } });
  });

  it("maps domain errors thrown by the cores to the envelope", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    class SendMessageError extends Error {
      code = "whatsapp_not_configured";
      status = 409;
      name = "SendMessageError";
    }
    const res = await apiRoute(null, async () => {
      throw new SendMessageError("no channel");
    })(reqWith(KEY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "whatsapp_not_configured", message: "no channel" } });
  });

  it("does not log unauthenticated calls", async () => {
    const res = await apiRoute(null, async () => ok({}))(reqWith());
    expect(res.status).toBe(401);
    expect(logged).toHaveLength(0);
  });
});
