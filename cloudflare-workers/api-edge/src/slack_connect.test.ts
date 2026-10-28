import { describe, expect, it } from "vitest";
import { channelNameFor, isInternalEmail, runSlackConnectInvites, type SlackConnectEnv } from "./slack_connect";

// The cron's SQL runs against the real schema: the snapshot,
// then every migration statement it does not already contain, in node:sqlite (see agent_feedback.test.ts for why
// the builtins are reached this way).
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, enc: "utf8"): string;
  readdirSync(path: string): string[];
};

class Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...p: unknown[]): this {
    this.params = p;
    return this;
  }
  private args(): unknown[] {
    return this.params.map((v) => (v === undefined ? null : v));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run(): Promise<{ success: true; meta: object }> {
    this.db.prepare(this.sql).run(...this.args());
    return { success: true, meta: {} };
  }
}

function schemaDB(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const root = process.cwd();
  db.exec(fs.readFileSync(`${root}/schema-snapshots/current_schema.sql`, "utf8"));
  for (const file of fs.readdirSync(`${root}/migrations`).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(`${root}/migrations/${file}`, "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of sql.split(/;\s*$/m).filter((s) => s.trim())) {
      try {
        db.exec(statement);
      } catch (err) {
        if (!/already exists|duplicate column/.test(String(err))) throw err;
      }
    }
  }
  return db;
}

function d1(db: DatabaseSync): D1Database {
  return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
}

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const SINCE = NOW / 1000 - 3600;

// A fake Slack: records every call; `errors` maps a method to the error it returns.
function fakeSlack(errors: Record<string, string | string[]> = {}, taken: string[] = []) {
  const calls: { method: string; params: Record<string, string> }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split("/api/")[1];
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ method, params });
    const e = errors[method];
    const err = Array.isArray(e) ? e.shift() : e;
    if (err === "429") return new Response("", { status: 429 });
    if (err) return Response.json({ ok: false, error: err });
    if (method === "conversations.create") {
      if (taken.includes(params.name)) return Response.json({ ok: false, error: "name_taken" });
      taken.push(params.name);
      return Response.json({ ok: true, channel: { id: `C${++n}`, name: params.name } });
    }
    if (method === "auth.test") return Response.json({ ok: true, user_id: "U1" });
    if (method === "conversations.inviteShared") return Response.json({ ok: true, invite_id: `I${n}` });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, methods: () => calls.map((c) => c.method) };
}

function setup(users: [string, string, number?][]) {
  const db = schemaDB();
  for (const [id, email, created] of users) {
    db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(id, email, created ?? SINCE + 60);
  }
  const env: SlackConnectEnv = {
    OPENCOMPUTER_DB: d1(db),
    SLACK_CONNECT_TOKEN: "xoxp-test",
    SLACK_CONNECT_SINCE: String(SINCE),
    SLACK_CONNECT_TEAM_USER_IDS: "U1,U2,U3",
  };
  const rows = () =>
    db.prepare("SELECT user_id, channel_name, channel_id, status, attempts, last_error FROM slack_connect_invites ORDER BY user_id").all() as {
      user_id: string; channel_name: string; channel_id: string | null; status: string; attempts: number; last_error: string | null;
    }[];
  return { db, env, rows };
}

describe("channel names", () => {
  it("names work email by company and free email by address", () => {
    expect(channelNameFor("jane@acme.com")).toBe("opencomputer-acme");
    expect(channelNameFor("jane@eng.acme.co.uk")).toBe("opencomputer-acme");
    expect(channelNameFor("Jane.Doe+oc@gmail.com")).toBe("opencomputer-jane-doe");
    expect(channelNameFor(`${"x".repeat(100)}@gmail.com`).length).toBeLessThanOrEqual(77);
  });

  it("knows internal accounts", () => {
    expect(isInternalEmail("igor@digger.dev")).toBe(true);
    expect(isInternalEmail("i.zalutski+x@gmail.com")).toBe(true);
    expect(isInternalEmail("someone@gmail.com")).toBe(false);
  });
});

describe("runSlackConnectInvites", () => {
  it("does nothing without a token or a start time", async () => {
    const { env, rows } = setup([["u1", "jane@acme.com"]]);
    const slack = fakeSlack();
    await runSlackConnectInvites({ ...env, SLACK_CONNECT_TOKEN: undefined }, NOW, slack.fetchImpl);
    await runSlackConnectInvites({ ...env, SLACK_CONNECT_SINCE: undefined }, NOW, slack.fetchImpl);
    expect(slack.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("creates a channel, adds the team, invites the signup once", async () => {
    const { env, rows } = setup([["u1", "jane@acme.com"], ["old", "old@acme.com", SINCE - 1]]);
    const slack = fakeSlack();
    expect(await runSlackConnectInvites(env, NOW, slack.fetchImpl)).toMatchObject({ invited: 1 });
    expect(slack.calls).toEqual([
      { method: "conversations.create", params: { name: "opencomputer-acme", is_private: "false" } },
      { method: "auth.test", params: {} },
      // U1 is the token's own user, already in the channel it created.
      { method: "conversations.invite", params: { channel: "C1", users: "U2,U3", force: "true" } },
      { method: "conversations.inviteShared", params: { channel: "C1", emails: "jane@acme.com" } },
    ]);
    expect(rows()).toMatchObject([{ user_id: "u1", channel_id: "C1", status: "invited" }]);

    await runSlackConnectInvites(env, NOW + 300_000, slack.fetchImpl);
    expect(slack.calls).toHaveLength(4);
  });

  it("puts colleagues in one channel and free-email users in their own", async () => {
    const { env, rows } = setup([
      ["u1", "jane@acme.com", SINCE + 1],
      ["u2", "bob@acme.com", SINCE + 2],
      ["u3", "acme@gmail.com", SINCE + 3],
    ]);
    const slack = fakeSlack();
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    // Three creates: acme, then acme@gmail.com's opencomputer-acme (taken) and opencomputer-acme-2.
    expect(slack.methods().filter((m) => m === "conversations.create")).toHaveLength(3);
    expect(rows().map((r) => [r.user_id, r.channel_name, r.channel_id])).toEqual([
      ["u1", "opencomputer-acme", "C1"],
      ["u2", "opencomputer-acme", "C1"],
      ["u3", "opencomputer-acme-2", "C2"],
    ]);
  });

  it("suffixes a taken name instead of joining someone else's channel", async () => {
    const { env, rows } = setup([["u1", "jane@gmail.com"]]);
    const slack = fakeSlack({}, ["opencomputer-jane"]);
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(rows()).toMatchObject([{ channel_name: "opencomputer-jane-2", channel_id: "C1", status: "invited" }]);
  });

  it("skips internal accounts without calling Slack", async () => {
    const { env, rows } = setup([["u1", "mo@opencomputer.dev"]]);
    const slack = fakeSlack();
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(slack.calls).toEqual([]);
    expect(rows()).toMatchObject([{ status: "skipped" }]);
  });

  it("retries a failed invite on the next tick without a second channel", async () => {
    const { env, rows } = setup([["u1", "jane@acme.com"]]);
    const slack = fakeSlack({ "conversations.inviteShared": ["internal_error"] });
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(rows()).toMatchObject([{ status: "pending", attempts: 1, channel_id: "C1", last_error: "internal_error" }]);
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(slack.methods()).toEqual([
      "conversations.create", "auth.test", "conversations.invite", "conversations.inviteShared", "conversations.inviteShared",
    ]);
    expect(rows()).toMatchObject([{ status: "invited", last_error: null }]);
  });

  it("gives up at once on a permanent error, and after five tries otherwise", async () => {
    const { env, rows } = setup([["u1", "jane@acme.com", SINCE + 1], ["u2", "bob@other.io", SINCE + 2]]);
    const slack = fakeSlack({ "conversations.inviteShared": ["not_paid", ...Array(10).fill("internal_error")] });
    for (let i = 0; i < 6; i++) await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(rows()).toMatchObject([
      { user_id: "u1", status: "failed", attempts: 1 },
      { user_id: "u2", status: "failed", attempts: 5 },
    ]);
  });

  it("stops the tick on a rate limit and resumes later", async () => {
    const { env, rows } = setup([["u1", "jane@acme.com", SINCE + 1], ["u2", "bob@other.io", SINCE + 2]]);
    const slack = fakeSlack({ "conversations.create": ["429"] });
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(slack.methods()).toEqual(["conversations.create"]);
    await runSlackConnectInvites(env, NOW, slack.fetchImpl);
    expect(rows()).toMatchObject([{ status: "invited" }, { status: "invited" }]);
  });

  it("respects the batch size", async () => {
    const { env, rows } = setup([["u1", "a@a.com", SINCE + 1], ["u2", "b@b.com", SINCE + 2]]);
    await runSlackConnectInvites({ ...env, SLACK_CONNECT_BATCH: "1" }, NOW, fakeSlack().fetchImpl);
    expect(rows().map((r) => r.user_id)).toEqual(["u1"]);
  });
});
