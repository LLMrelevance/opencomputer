import { describe, expect, it } from "vitest";
import { envWithD1Retry, isD1Overloaded, withD1Retry } from "./d1_retry";

const OVERLOADED = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");

// Fake D1 whose executions fail with `failures` errors (in order) before succeeding.
function fakeDB(failures: Error[]) {
  const calls: string[] = [];
  const queue = [...failures];
  const exec = (label: string) => {
    calls.push(label);
    const next = queue.shift();
    return next ? Promise.reject(next) : Promise.resolve({ label });
  };
  const stmt = (sql: string, args: unknown[] = []): D1PreparedStatement =>
    ({
      sql,
      args,
      bind: (...a: unknown[]) => stmt(sql, a),
      first: () => exec(`first:${sql}:${args.join(",")}`),
      all: () => exec(`all:${sql}`),
      run: () => exec(`run:${sql}`),
      raw: () => exec(`raw:${sql}`),
    }) as unknown as D1PreparedStatement;
  const batched: unknown[][] = [];
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: (stmts: D1PreparedStatement[]) => {
      batched.push(stmts);
      return exec(`batch:${stmts.length}`);
    },
    exec: (sql: string) => exec(`exec:${sql}`),
    withSession: () => db,
  } as unknown as D1Database;
  return { db, calls, batched };
}

const noSleep = { sleep: async () => {} };

describe("isD1Overloaded", () => {
  it("matches only the overload error", () => {
    expect(isD1Overloaded(OVERLOADED)).toBe(true);
    expect(isD1Overloaded(new Error("D1_ERROR: UNIQUE constraint failed: users.email"))).toBe(false);
    expect(isD1Overloaded(new Error("D1_ERROR: Network connection lost."))).toBe(false);
  });
});

describe("withD1Retry", () => {
  it("retries an overloaded read and returns the result", async () => {
    const { db, calls } = fakeDB([OVERLOADED]);
    const r = await withD1Retry(db, noSleep).prepare("SELECT 1 WHERE x = ?1").bind("a").first();
    expect(r).toEqual({ label: "first:SELECT 1 WHERE x = ?1:a" });
    expect(calls).toHaveLength(2);
  });

  it("retries run/all/raw", async () => {
    for (const m of ["run", "all", "raw"] as const) {
      const { db, calls } = fakeDB([OVERLOADED]);
      await withD1Retry(db, noSleep).prepare("Q")[m]();
      expect(calls).toHaveLength(2);
    }
  });

  it("gives up after two retries and rethrows the overload error", async () => {
    const { db, calls } = fakeDB([OVERLOADED, OVERLOADED, OVERLOADED, OVERLOADED]);
    await expect(withD1Retry(db, noSleep).prepare("Q").run()).rejects.toBe(OVERLOADED);
    expect(calls).toHaveLength(3);
  });

  it("never retries other errors", async () => {
    const constraint = new Error("D1_ERROR: UNIQUE constraint failed: users.email");
    const { db, calls } = fakeDB([constraint]);
    await expect(withD1Retry(db, noSleep).prepare("INSERT").run()).rejects.toBe(constraint);
    expect(calls).toHaveLength(1);
  });

  it("hands batch() the raw statements and retries the whole batch", async () => {
    const { db, calls, batched } = fakeDB([OVERLOADED]);
    const w = withD1Retry(db, noSleep);
    const a = w.prepare("A").bind(1);
    const b = w.prepare("B");
    await w.batch([a, b]);
    expect(calls).toEqual(["batch:2", "batch:2"]);
    expect((batched[0] as D1PreparedStatement[])[0]).not.toBe(a); // raw, not the wrapper
    expect((batched[0] as Array<{ sql: string }>).map((s) => s.sql)).toEqual(["A", "B"]);
  });

  it("wraps sessions too", async () => {
    const { db, calls } = fakeDB([OVERLOADED]);
    await withD1Retry(db, noSleep).withSession("first-primary").prepare("Q").first();
    expect(calls).toHaveLength(2);
  });

  it("waits between attempts with growing delays", async () => {
    const waits: number[] = [];
    const { db } = fakeDB([OVERLOADED, OVERLOADED]);
    await withD1Retry(db, { sleep: async (ms) => void waits.push(ms) }).prepare("Q").run();
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThan(200);
    expect(waits[1]).toBeGreaterThanOrEqual(300);
    expect(waits[1]).toBeLessThan(600);
  });
});

describe("envWithD1Retry", () => {
  it("leaves the original env and other bindings untouched", () => {
    const { db } = fakeDB([]);
    const env = { OPENCOMPUTER_DB: db, WORKER_ENV: "prod" };
    const wrapped = envWithD1Retry(env);
    expect(env.OPENCOMPUTER_DB).toBe(db);
    expect(wrapped.OPENCOMPUTER_DB).not.toBe(db);
    expect(wrapped.WORKER_ENV).toBe("prod");
    expect(envWithD1Retry(env).OPENCOMPUTER_DB).toBe(wrapped.OPENCOMPUTER_DB);
  });
});
