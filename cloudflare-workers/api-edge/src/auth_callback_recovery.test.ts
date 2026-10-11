import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

// Login-path recovery from D1 overload: the retry wrapper absorbs short blips,
// and a callback that still fails after the WorkOS exchange restarts the login
// once instead of throwing (Cloudflare 1101).

const OVERLOADED = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";

function makeEnv(overloadedCalls: number) {
  let remaining = overloadedCalls;
  const executed: string[] = [];
  const maybeFail = (sql: string) => {
    executed.push(sql.split(/\s+/).slice(0, 3).join(" "));
    if (remaining === Infinity || remaining-- > 0) throw new Error(OVERLOADED);
  };
  const user = { id: "user-1", email: "u@example.com", name: "U" };
  const membership = {
    id: "org-1", name: "U's workspace", plan: "free", is_personal: 1,
    workos_org_id: null, membership_created_at: 1, org_created_at: 1,
  };
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    first: async () => {
      maybeFail(sql);
      if (sql.includes("FROM users")) return user;
      if (sql.includes("org_memberships")) return membership;
      return null;
    },
    all: async () => {
      maybeFail(sql);
      return { results: [] };
    },
    run: async () => {
      maybeFail(sql);
      return { success: true, meta: {} };
    },
  });
  const env = {
    OPENCOMPUTER_DB: { prepare: stmt, batch: async () => [] },
    SESSION_JWT_SECRET: "test-secret",
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    WORKER_ENV: "test",
  } as unknown as Env;
  return { env, executed };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

const callback = (state?: object) => {
  const u = new URL("https://app.opencomputer.dev/auth/callback?code=c1");
  if (state) u.searchParams.set("state", JSON.stringify(state));
  return new Request(u);
};

describe("auth callback under D1 overload", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ user: { id: "wos-1", email: "u@example.com", first_name: "U" } }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs the user in when the first query is overloaded once (retry absorbs it)", async () => {
    const { env, executed } = makeEnv(1);
    const resp = await worker.fetch(callback(), env, ctx);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe("https://app.opencomputer.dev/dashboard");
    expect(resp.headers.get("set-cookie")).toMatch(/^oc_session=/);
    expect(executed[0]).toBe(executed[1]); // same query re-sent once
  });

  it("restarts the login once when D1 stays overloaded, keeping returnTo", async () => {
    const { env } = makeEnv(Infinity);
    const resp = await worker.fetch(callback({ returnTo: "/projects" }), env, ctx);
    expect(resp.status).toBe(302);
    const loc = new URL(resp.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/login");
    expect(loc.searchParams.get("retried")).toBe("1");
    expect(loc.searchParams.get("returnTo")).toBe("/projects");
    expect(resp.headers.get("set-cookie")).toBeNull();
  });

  it("shows a retry page instead of looping on the second failure", async () => {
    const { env } = makeEnv(Infinity);
    const resp = await worker.fetch(callback({ retried: true }), env, ctx);
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain('href="/auth/login"');
  });

  it("carries the retried flag through WorkOS state on the restarted login", async () => {
    const { env } = makeEnv(0);
    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/login?retried=1&returnTo=/projects"),
      env,
      ctx,
    );
    const state = JSON.parse(new URL(resp.headers.get("location")!).searchParams.get("state")!);
    expect(state).toEqual({ returnTo: "/projects", retried: true });
  });

  it("leaves a normal login's state unchanged", async () => {
    const { env } = makeEnv(0);
    const plain = await worker.fetch(new Request("https://app.opencomputer.dev/auth/login"), env, ctx);
    expect(new URL(plain.headers.get("location")!).searchParams.get("state")).toBeNull();
    const deep = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/login?returnTo=/projects"),
      env,
      ctx,
    );
    expect(JSON.parse(new URL(deep.headers.get("location")!).searchParams.get("state")!)).toEqual({
      returnTo: "/projects",
    });
  });

  it("still lands on returnTo after a clean login", async () => {
    const { env } = makeEnv(0);
    const resp = await worker.fetch(callback({ returnTo: "/projects", retried: true }), env, ctx);
    expect(resp.headers.get("location")).toBe("https://app.opencomputer.dev/projects");
  });
});
