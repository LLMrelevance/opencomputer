// Slack Connect per signup (serverless-agents-ws 089). Each new user gets a
// shared channel with the team in our Slack workspace: the cron creates
// #opencomputer-<company> (one per work-email domain, one per user for free
// email), adds the team, and sends a Slack Connect invite to the user's email.
//
// Runs on the */5 cron, never in the login path. A row in slack_connect_invites
// is the claim that a user is handled, so a re-run does nothing; a Slack error
// leaves the row pending and the next tick retries, up to MAX_ATTEMPTS.
// Dormant unless SLACK_CONNECT_BOT_TOKEN and SLACK_CONNECT_SINCE are set; SINCE
// keeps the first deploy from inviting every user who signed up before it.

export interface SlackConnectEnv {
  OPENCOMPUTER_DB: D1Database;
  SLACK_CONNECT_BOT_TOKEN?: string;
  SLACK_CONNECT_SINCE?: string; // unix seconds; only users created at or after it
  SLACK_CONNECT_TEAM_USER_IDS?: string; // comma-separated Slack user ids added to every channel
  SLACK_CONNECT_BATCH?: string; // users per tick, default 10
}

const CHANNEL_PREFIX = "opencomputer-";
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 10;

const INTERNAL_DOMAINS = new Set(["digger.dev", "opencomputer.dev"]);
// Team members' personal Gmail accounts, as in oc-usage-chart's is_internal_email.
const INTERNAL_GMAIL_LOCALS = new Set(["izalutski", "zij2005", "moehabib9"]);

// Mailbox providers: their users share a domain but not a company, so each gets
// a channel of their own named after the address.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "web.de", "mail.com",
  "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "zoho.com", "fastmail.com",
  "hey.com", "tutanota.com",
]);

// Slack errors that will not change on retry: give up on the user at once.
const PERMANENT_ERRORS = new Set([
  "invalid_email", "restricted_action", "not_allowed_token_type", "not_paid",
  "team_not_found", "user_is_restricted", "invite_not_allowed",
]);

export function isInternalEmail(email: string): boolean {
  const [local, domain] = splitEmail(email);
  if (INTERNAL_DOMAINS.has(domain)) return true;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return INTERNAL_GMAIL_LOCALS.has(local.replace(/\+.*$/, "").replace(/\./g, ""));
  }
  return false;
}

export function isFreeEmail(email: string): boolean {
  return FREE_EMAIL_DOMAINS.has(splitEmail(email)[1]);
}

// #opencomputer-acme for jane@eng.acme.co.uk; #opencomputer-jane-doe for
// jane.doe+oc@gmail.com. Slack channel names: lowercase, digits, - and _, at most
// 80 characters; room is left for a -N suffix on a name collision.
export function channelNameFor(email: string): string {
  const [local, domain] = splitEmail(email);
  let base: string;
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    base = local.replace(/\+.*$/, "");
  } else {
    const labels = domain.split(".");
    labels.pop();
    if (labels.length > 1 && /^(co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 1])) labels.pop();
    base = labels[labels.length - 1] ?? domain;
  }
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return CHANNEL_PREFIX + (slug || "user").slice(0, 80 - CHANNEL_PREFIX.length - 3);
}

function splitEmail(email: string): [string, string] {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at < 0 ? [e, ""] : [e.slice(0, at), e.slice(at + 1)];
}

class SlackRateLimited extends Error {}

type SlackResponse = { ok: boolean; error?: string; [k: string]: unknown };

async function slackCall(
  env: SlackConnectEnv,
  fetchImpl: typeof fetch,
  method: string,
  params: Record<string, string>,
): Promise<SlackResponse> {
  const resp = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_CONNECT_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (resp.status === 429) throw new SlackRateLimited(method);
  if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
  return (await resp.json()) as SlackResponse;
}

interface Candidate {
  user_id: string;
  email: string;
  created_at: number;
  channel_name: string | null;
  channel_id: string | null;
  attempts: number | null;
}

export async function runSlackConnectInvites(
  env: SlackConnectEnv,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ invited: number; skipped: number; failed: number; pending: number }> {
  const counts = { invited: 0, skipped: 0, failed: 0, pending: 0 };
  const since = Number(env.SLACK_CONNECT_SINCE);
  if (!env.SLACK_CONNECT_BOT_TOKEN || !Number.isFinite(since) || since <= 0) return counts;
  const batch = Number(env.SLACK_CONNECT_BATCH) || DEFAULT_BATCH;
  const nowSec = Math.floor(nowMs / 1000);

  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT u.id AS user_id, u.email, u.created_at, s.channel_name, s.channel_id, s.attempts
       FROM users u
       LEFT JOIN slack_connect_invites s ON s.user_id = u.id
      WHERE u.created_at >= ?1 AND (s.user_id IS NULL OR s.status = 'pending')
      ORDER BY u.created_at ASC
      LIMIT ?2`,
  )
    .bind(since, batch)
    .all<Candidate>();

  for (const c of results ?? []) {
    try {
      const status = await inviteOne(env, fetchImpl, c, nowSec);
      counts[status]++;
    } catch (err) {
      if (err instanceof SlackRateLimited) {
        console.warn(`slack-connect: rate limited on ${err.message}; resuming next tick`);
        counts.pending++;
        break;
      }
      throw err;
    }
  }
  if (counts.invited + counts.failed > 0) console.log("slack-connect:", JSON.stringify(counts));
  return counts;
}

async function inviteOne(
  env: SlackConnectEnv,
  fetchImpl: typeof fetch,
  c: Candidate,
  nowSec: number,
): Promise<"invited" | "skipped" | "failed" | "pending"> {
  if (c.channel_name === null) {
    const internal = isInternalEmail(c.email);
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO slack_connect_invites (user_id, email, channel_name, status, attempts, created_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5) ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(c.user_id, c.email, channelNameFor(c.email), internal ? "skipped" : "pending", nowSec)
      .run();
    if (internal) return "skipped";
    c.channel_name = channelNameFor(c.email);
    c.attempts = 0;
  }

  const fail = async (error: string): Promise<"failed" | "pending"> => {
    const attempts = (c.attempts ?? 0) + 1;
    const status = PERMANENT_ERRORS.has(error) || attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE slack_connect_invites SET attempts = ?2, last_error = ?3, status = ?4 WHERE user_id = ?1`,
    )
      .bind(c.user_id, attempts, error, status)
      .run();
    console.warn(`slack-connect: ${c.user_id} ${error} (attempt ${attempts}, ${status})`);
    return status;
  };

  let channelID = c.channel_id;
  if (!channelID && !isFreeEmail(c.email)) {
    // A colleague's channel: everyone at a work domain shares one.
    const shared = await env.OPENCOMPUTER_DB.prepare(
      `SELECT channel_id FROM slack_connect_invites
        WHERE lower(substr(email, instr(email, '@') + 1)) = ?1 AND channel_id IS NOT NULL
        LIMIT 1`,
    )
      .bind(splitEmail(c.email)[1])
      .first<{ channel_id: string }>();
    channelID = shared?.channel_id ?? null;
    if (channelID) {
      await env.OPENCOMPUTER_DB.prepare(`UPDATE slack_connect_invites SET channel_id = ?2 WHERE user_id = ?1`)
        .bind(c.user_id, channelID)
        .run();
    }
  }
  if (!channelID) {
    // A taken name (another free-email user with the same local part, or a
    // channel made by hand) gets a -2..-9 suffix rather than reusing a stranger's channel.
    let name = c.channel_name;
    for (let n = 2; ; n++) {
      const r = await slackCall(env, fetchImpl, "conversations.create", { name, is_private: "false" });
      if (r.ok) {
        channelID = (r.channel as { id: string }).id;
        break;
      }
      if (r.error !== "name_taken" || n > 9) return fail(r.error ?? "create_failed");
      name = `${c.channel_name}-${n}`;
    }
    c.channel_name = name;
    await env.OPENCOMPUTER_DB.prepare(`UPDATE slack_connect_invites SET channel_id = ?2, channel_name = ?3 WHERE user_id = ?1`)
      .bind(c.user_id, channelID, name)
      .run();

    const team = (env.SLACK_CONNECT_TEAM_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (team.length > 0) {
      // Not fatal: the invite still goes out, and the team can join by hand.
      const r = await slackCall(env, fetchImpl, "conversations.invite", {
        channel: channelID,
        users: team.join(","),
        force: "true",
      });
      if (!r.ok && r.error !== "already_in_channel") {
        console.warn(`slack-connect: adding team to ${channelID} failed: ${r.error}`);
      }
    }
  }

  const r = await slackCall(env, fetchImpl, "conversations.inviteShared", {
    channel: channelID,
    emails: c.email,
  });
  if (!r.ok) return fail(r.error ?? "invite_failed");
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE slack_connect_invites SET status = 'invited', invite_id = ?2, invited_at = ?3, last_error = NULL
      WHERE user_id = ?1`,
  )
    .bind(c.user_id, typeof r.invite_id === "string" ? r.invite_id : null, nowSec)
    .run();
  return "invited";
}
