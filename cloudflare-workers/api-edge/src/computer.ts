// The organization's computer (serverless-agents-ws work 052). The dashboard
// calls `/api/dashboard/managed-agents/computer…`; the edge proxies those
// routes to the backend's `/v1/computer…` with its org assertion. They are
// dashboard-only in v1: the API-key mount `/api/managed-agents` refuses them.
//
// Response bodies are rebuilt field by field from the binding contract, so a
// contract body passes through unchanged while anything the backend adds
// beside it (where the machine runs, what size it is) never reaches a browser.

import type { RouteFamily } from "./route_family";

const COMPUTER_ROUTE = /^\/computer(?:\/|$)/;
const COMPUTER_AGENT_ROUTE = /^\/computer\/agent(?:\/|$)/;

// The backend's codes are stable; the messages are written here so no
// infrastructure detail (cloud, capacity pools, hosts) reaches the dashboard.
export const COMPUTER_ERROR_MESSAGES: Record<string, string> = {
  computer_not_configured:
    "Computers are not available for this organization yet.",
  computer_not_found: "This organization does not have a computer yet.",
  computer_unavailable:
    "Your computer is temporarily unavailable. Try again shortly.",
  computer_capacity_unavailable:
    "We could not set up your computer right now. Try again shortly.",
  computer_busy: "Your computer is changing state. Try again in a moment.",
  computer_slack_not_configured:
    "The OpenComputer Slack app is not available yet.",
  computer_slack_not_installed:
    "No Slack workspace is linked to this organization.",
  computer_slack_already_linked:
    "That Slack workspace is already linked to another organization.",
  // Choose your agent (work 081).
  computer_agent_token_format:
    "That's not a setup token. It starts with sk-ant-oat01-.",
  computer_agent_token_rejected:
    "That token didn't work. Run claude setup-token again and paste the new one.",
  computer_agent_rate_limited: "Too many tries. Wait a few minutes.",
  computer_agent_already_connected:
    "Someone else already connected a subscription for this organization.",
  computer_agent_connect_in_slack: "Connect from Slack: !claude connect",
  computer_agent_disabled: "Your workspace admin turned this off.",
  computer_agent_not_member:
    "You're not a member of this organization's Slack workspace.",
  // One-command connect (work 082).
  computer_agent_codex_auth:
    "That's not a ChatGPT login. Paste the auth.json that codex login wrote.",
  computer_connect_code_invalid:
    "That connect code is not valid. Get a new one from the dashboard.",
  computer_harness_unavailable:
    "That agent isn't available on this computer yet.",
  invalid_request: "That choice isn't valid.",
};

/**
 * Fallback copy for a computer route when the backend's code is unknown. A
 * 404 on an agent route is an older backend without work 081, not a missing
 * computer, so it reads as the feature being on its way.
 */
function computerFallbackMessage(status: number, suffix: string): string {
  if (status === 401 || status === 403) {
    return "You do not have access to this organization's computer.";
  }
  if (status === 404) {
    return COMPUTER_AGENT_ROUTE.test(suffix)
      ? "Connecting a subscription isn't available yet. Try again shortly."
      : "This organization does not have a computer yet.";
  }
  if (status === 409) {
    return "Your computer is changing state. Try again in a moment.";
  }
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status >= 500) {
    return "Your computer is temporarily unavailable. Try again shortly.";
  }
  return "The computer request could not be completed.";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function publicComputer(value: unknown): Record<string, unknown> | null {
  const computer = record(value);
  if (!computer) return null;
  return {
    state: computer.state,
    connected: computer.connected === true,
    vcpus: computer.vcpus,
    memoryGiB: computer.memoryGiB,
    diskGiB: computer.diskGiB,
    lastError: optionalString(computer.lastError),
    createdAt: computer.createdAt,
    updatedAt: computer.updatedAt,
  };
}

const AGENT_CHOICES = new Set(["claude", "codex", "credits"]);
const SUBSCRIPTION_PROVIDERS = new Set(["claude", "codex"]);
// A ChatGPT plan name from the token's claims ("plus", "pro", "team"...).
const SUBSCRIPTION_PLAN = /^[A-Za-z0-9_-]{1,32}$/;
const SUBSCRIPTION_HEALTH = new Set([
  "ok",
  "unchecked",
  "paused",
  "limited",
  "invalid",
]);

function publicSlackUser(value: unknown): Record<string, string> | null {
  const user = record(value);
  if (
    !user ||
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.teamName !== "string"
  ) {
    return null;
  }
  return { id: user.id, name: user.name, teamName: user.teamName };
}

// `undefined` when the value breaks the contract; `null` is a real "none".
function publicSubscription(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const subscription = record(value);
  if (
    !subscription ||
    typeof subscription.provider !== "string" ||
    !SUBSCRIPTION_PROVIDERS.has(subscription.provider) ||
    typeof subscription.health !== "string" ||
    !SUBSCRIPTION_HEALTH.has(subscription.health) ||
    typeof subscription.setAt !== "string"
  ) {
    return undefined;
  }
  return {
    provider: subscription.provider,
    health: subscription.health,
    ...(typeof subscription.limitedUntil === "string"
      ? { limitedUntil: subscription.limitedUntil }
      : {}),
    setAt: subscription.setAt,
    ...(subscription.provider === "codex" &&
    typeof subscription.plan === "string" &&
    SUBSCRIPTION_PLAN.test(subscription.plan)
      ? { plan: subscription.plan }
      : {}),
  };
}

/**
 * The person's agent block (work 081), rebuilt field by field. Null when the
 * backend sends none or one that breaks the contract: the dashboard then
 * skips the agent step rather than guessing.
 */
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_HARNESSES = 16;

/** Known-safe harness names, once each, in blue's order. */
function publicHarnesses(values: unknown[]): string[] {
  const names = values.filter(
    (value): value is string =>
      typeof value === "string" && HARNESS.test(value),
  );
  return [...new Set(names)].slice(0, MAX_HARNESSES);
}

export function publicComputerAgent(
  value: unknown,
): Record<string, unknown> | null {
  const agent = record(value);
  if (!agent) return null;
  const choice = agent.choice ?? null;
  if (
    choice !== null &&
    !(typeof choice === "string" && AGENT_CHOICES.has(choice))
  ) {
    return null;
  }
  const subscription = publicSubscription(agent.subscription ?? null);
  if (subscription === undefined) return null;
  if (typeof agent.managedModel !== "string" || !agent.managedModel) {
    return null;
  }
  const linkedSlackUser = publicSlackUser(agent.linkedSlackUser);
  return {
    choice,
    linked: agent.linked === true,
    ...(linkedSlackUser ? { linkedSlackUser } : {}),
    subscription,
    managedModel: agent.managedModel,
    // The harnesses this computer can run (work 082): the rollout gate and
    // kill switch. Absent from an older blue, so absent here too, and the
    // web keeps today's Claude-only cards.
    ...(Array.isArray(agent.harnesses)
      ? { harnesses: publicHarnesses(agent.harnesses) }
      : {}),
  };
}

function requiredAgent(value: unknown): Record<string, unknown> {
  const agent = publicComputerAgent(value);
  if (!agent) throw new Error("Invalid computer agent");
  return agent;
}

function publicComputerStatus(body: Record<string, unknown>) {
  const slack = record(body.slack) ?? {};
  const github = record(body.github) ?? {};
  const agent = publicComputerAgent(body.agent);
  return {
    computer: publicComputer(body.computer),
    slack: {
      installed: slack.installed === true,
      ...(typeof slack.teamId === "string" ? { teamId: slack.teamId } : {}),
      ...(typeof slack.teamName === "string"
        ? { teamName: slack.teamName }
        : {}),
      ...(typeof slack.botUserId === "string"
        ? { botUserId: slack.botUserId }
        : {}),
    },
    github: {
      connected: github.connected === true,
      installations: Array.isArray(github.installations)
        ? github.installations.map((value) => {
            const installation = record(value) ?? {};
            return {
              id:
                typeof installation.id === "number"
                  ? String(installation.id)
                  : installation.id,
              accountLogin: installation.accountLogin,
            };
          })
        : [],
    },
    plan: body.plan === "paid" ? "paid" : "free",
    ...(agent ? { agent } : {}),
  };
}

function httpsURL(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publicComputerSession(value: unknown): Record<string, unknown> {
  const session = record(value) ?? {};
  return {
    key: session.key,
    title: session.title,
    channelId: session.channelId,
    threadTs: session.threadTs,
    ownerSlackUserId: optionalString(session.ownerSlackUserId),
    status: session.status,
    updatedAt: session.updatedAt,
    slackUrl: httpsURL(session.slackUrl),
  };
}

function publicComputerSessions(body: Record<string, unknown>) {
  return {
    sessions: Array.isArray(body.sessions)
      ? body.sessions.map(publicComputerSession)
      : [],
  };
}

function publicSlackInstall(body: Record<string, unknown>) {
  const url = httpsURL(body.url);
  if (!url) throw new Error("Invalid Slack install URL");
  return { url };
}

function publicAgentConnect(body: Record<string, unknown>) {
  const via = body.via;
  if (via !== "own" && via !== "pool" && via !== "none") {
    throw new Error("Invalid computer agent connect response");
  }
  return {
    agent: requiredAgent(body.agent),
    verified: body.verified === true,
    via,
  };
}

function publicAgentOnly(body: Record<string, unknown>) {
  return { agent: requiredAgent(body.agent) };
}

function publicConnectCode(body: Record<string, unknown>) {
  if (
    typeof body.code !== "string" ||
    !body.code ||
    typeof body.expiresAt !== "string"
  ) {
    throw new Error("Invalid computer connect code response");
  }
  return { code: body.code, expiresAt: body.expiresAt };
}

/**
 * The contract's routes. `shape` rebuilds the success body from the
 * backend's; `null` means the route answers with no content (unlinking
 * Slack, disconnecting the agent), whatever the backend sent beside 204.
 */
const COMPUTER_ROUTES: ReadonlyArray<{
  method: string;
  suffix: string;
  shape: ((body: Record<string, unknown>) => unknown) | null;
}> = [
  { method: "GET", suffix: "/computer", shape: publicComputerStatus },
  { method: "POST", suffix: "/computer", shape: publicComputerStatus },
  {
    method: "GET",
    suffix: "/computer/sessions",
    shape: publicComputerSessions,
  },
  {
    method: "POST",
    suffix: "/computer/slack/install",
    shape: publicSlackInstall,
  },
  { method: "DELETE", suffix: "/computer/slack", shape: null },
  // Choose your agent (work 081).
  {
    method: "PUT",
    suffix: "/computer/agent/claude",
    shape: publicAgentConnect,
  },
  { method: "DELETE", suffix: "/computer/agent/claude", shape: null },
  {
    method: "POST",
    suffix: "/computer/agent/claude/resume",
    shape: publicAgentOnly,
  },
  { method: "PUT", suffix: "/computer/agent/choice", shape: publicAgentOnly },
  // One-command connect (work 082): the dashboard mints a code the CLI redeems
  // on the public connect route; Codex's auth.json can also come in directly.
  {
    method: "POST",
    suffix: "/computer/agent/connect-code",
    shape: publicConnectCode,
  },
  { method: "PUT", suffix: "/computer/agent/codex", shape: publicAgentOnly },
  { method: "DELETE", suffix: "/computer/agent/codex", shape: null },
];

function computerRoute(method: string, suffix: string) {
  return COMPUTER_ROUTES.find(
    (route) => route.method === method && route.suffix === suffix,
  );
}

/**
 * Codes whose backend message is written for people and names the agent
 * ("Codex isn't available on this computer yet."): it passes through when
 * it reads as one plain line, else the fixed copy above stands in.
 */
const BACKEND_WORDED_CODES = new Set(["computer_harness_unavailable"]);
const PERSON_READABLE = /^[^\p{Cc}<>]{1,200}$/u;

export const computerFamily: RouteFamily = {
  owns: (suffix) => COMPUTER_ROUTE.test(suffix),
  allows: (method, suffix) => computerRoute(method, suffix) !== undefined,
  // A dashboard surface in v1: API keys do not reach it.
  dashboardOnly: true,
  enabledFor: computerEnabledFor,
  async shapeSuccess(method, suffix, upstream) {
    const route = computerRoute(method, suffix);
    if (!route) throw new Error("Unsupported computer response");
    const headers = { "cache-control": "no-store" };
    if (!route.shape) return new Response(null, { status: 204, headers });
    const body = record(await upstream.json()) ?? {};
    return Response.json(route.shape(body), {
      status: upstream.status,
      headers,
    });
  },
  errorMessage: (code, status, suffix, backendMessage) =>
    BACKEND_WORDED_CODES.has(code) && PERSON_READABLE.test(backendMessage)
      ? backendMessage
      : Object.hasOwn(COMPUTER_ERROR_MESSAGES, code)
        ? COMPUTER_ERROR_MESSAGES[code]
        : computerFallbackMessage(status, suffix),
};

/**
 * Whether an organization has its computer (work 052 rollout). Until
 * COMPUTER_ENABLED_FOR_ALL is "true", only organizations listed in
 * COMPUTER_ENABLED_ORGS (comma-separated ids) see it; for everyone else the
 * computer routes do not exist and the dashboard hides the page.
 */
export function computerEnabledFor(
  env: { COMPUTER_ENABLED_FOR_ALL?: string; COMPUTER_ENABLED_ORGS?: string },
  orgID: string | null | undefined,
): boolean {
  if (env.COMPUTER_ENABLED_FOR_ALL === "true") return true;
  if (!orgID) return false;
  return (env.COMPUTER_ENABLED_ORGS ?? "")
    .split(",")
    .map((id) => id.trim())
    .includes(orgID);
}
