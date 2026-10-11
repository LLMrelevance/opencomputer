// D1 overload retry. D1 sheds load with "D1 DB is overloaded. Requests queued
// for too long." when its request queue backs up. Cloudflare lists it as
// retryable: the query was rejected while queued and never ran, so re-sending
// it cannot double-apply a write. Only that exact error is retried; every other
// error (constraint violations, syntax, timeouts after execution started)
// propagates unchanged on the first attempt.

const OVERLOADED = "D1 DB is overloaded";
const DEFAULT_DELAYS_MS = [100, 300];

export function isD1Overloaded(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(OVERLOADED);
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface D1RetryOptions {
  delaysMs?: number[];
  sleep?: Sleep;
}

async function withRetry<T>(fn: () => Promise<T>, opts: Required<D1RetryOptions>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isD1Overloaded(err) || attempt >= opts.delaysMs.length) throw err;
      const base = opts.delaysMs[attempt];
      await opts.sleep(base + Math.floor(Math.random() * base));
    }
  }
}

// Wrapped statements remember their raw statement so batch() can hand D1 the
// objects it expects.
const rawStatement = new WeakMap<object, D1PreparedStatement>();

function wrapStatement(stmt: D1PreparedStatement, opts: Required<D1RetryOptions>): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") {
        return (...args: unknown[]) => wrapStatement(target.bind(...args), opts);
      }
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        return (...args: unknown[]) =>
          withRetry(() => (target[prop] as (...a: unknown[]) => Promise<unknown>).apply(target, args), opts);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  rawStatement.set(wrapped, stmt);
  return wrapped;
}

function unwrap(stmts: D1PreparedStatement[]): D1PreparedStatement[] {
  return stmts.map((s) => rawStatement.get(s) ?? s);
}

function wrapQueryable<T extends D1Database | D1DatabaseSession>(db: T, opts: Required<D1RetryOptions>): T {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), opts);
      }
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => withRetry(() => target.batch(unwrap(stmts)), opts);
      }
      if (prop === "withSession" && "withSession" in target) {
        return (...args: unknown[]) =>
          wrapQueryable((target as D1Database).withSession(...(args as [string?])), opts);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const wrappedDBs = new WeakMap<D1Database, D1Database>();

export function withD1Retry(db: D1Database, opts: D1RetryOptions = {}): D1Database {
  const full = { delaysMs: opts.delaysMs ?? DEFAULT_DELAYS_MS, sleep: opts.sleep ?? realSleep };
  if (opts.delaysMs || opts.sleep) return wrapQueryable(db, full);
  let w = wrappedDBs.get(db);
  if (!w) {
    w = wrapQueryable(db, full);
    wrappedDBs.set(db, w);
  }
  return w;
}

// Per-invocation env with the retrying binding. The original env is never
// mutated, so Durable Objects and anything holding the raw env are unaffected.
export function envWithD1Retry<E extends { OPENCOMPUTER_DB: D1Database }>(env: E): E {
  return { ...env, OPENCOMPUTER_DB: withD1Retry(env.OPENCOMPUTER_DB) };
}
