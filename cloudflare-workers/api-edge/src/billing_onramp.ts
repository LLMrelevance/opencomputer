// Billing on-ramp surface shared by the CLI / SDK error paths and the
// `GET /api/billing/credits` status endpoint. Everything an agent-driven client
// (Claude / Codex running the CLI) needs to steer the human to payment lives
// here: a stable error code, a checkout deep link, and a low-balance signal
// that fires before the hard stop.

import {
  activeUsagePlan,
  type AutumnSyncEnv,
  syncAutumnToD1,
  type UsagePlan,
} from "./autumn_webhook";

export { activeUsagePlan, type UsagePlan };

// Mirror of PLAN_CREDIT_GRANTS in autumn_webhook.ts (dollars). The base grant is
// the signup credit; low-balance fires at LOW_CREDIT_FRACTION of the plan grant.
const PLAN_GRANT_CENTS: Record<UsagePlan, number> = {
  base: 500,
  pro: 20_000,
  max: 200_000,
};
const LOW_CREDIT_FRACTION = 0.3;

export function lowCreditThresholdCents(plan: UsagePlan): number {
  return Math.round(PLAN_GRANT_CENTS[plan] * LOW_CREDIT_FRACTION);
}

export interface BillingLinks {
  billingUrl: string;
  upgradeUrl: string;
}

// The one plan new customers can buy. Its Autumn id stays `max` (no Stripe
// migration); it is displayed as "Pro". The old $20/mo plan (Autumn id `pro`)
// is retired for new customers and shown as "Pro (legacy)" to its existing
// subscribers only, so nothing here ever links to it. Top-ups are no longer
// sold either.
export const UPGRADE_PLAN = "max" as const;
export const UPGRADE_PLAN_PRICE_USD = 200;
export const PLAN_DISPLAY_NAMES: Record<UsagePlan, string> = {
  base: "Free",
  pro: "Pro (legacy)",
  max: "Pro",
};

// The free-tier paywall copy, shared by every surface. It does not state the
// grant amount: that is still $5 today and changes in a later step.
export const FREE_CREDITS_PAYWALL =
  `You've used your free credits. Upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) to keep going, ` +
  "or to use your own Claude or ChatGPT subscription.";

export function billingLinks(request: Request): BillingLinks {
  const origin = new URL(request.url).origin;
  return {
    billingUrl: `${origin}/billing`,
    upgradeUrl: `${origin}/billing?plan=${UPGRADE_PLAN}`,
  };
}

// Agent-facing out-of-credits message. Free (and unknown/legacy) orgs get the
// paywall; a legacy $20 Pro org is pointed at the same Pro upgrade; a $200 Pro
// org keeps its current halt (a later step moves it to GLM) but is never
// offered a top-up.
export function insufficientCreditsMessage(links: BillingLinks, plan?: UsagePlan | null): string {
  if (plan === "max") {
    return (
      "You've used this month's Pro credits. They renew at the start of the next billing period; " +
      `the user can review billing at ${links.billingUrl}. Do not retry until credits renew.`
    );
  }
  if (plan === "pro") {
    return (
      `You've used this month's credits. Ask the user to upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) at ${links.upgradeUrl} ` +
      "to keep going, or to use their own Claude or ChatGPT subscription; do not retry until they have."
    );
  }
  return (
    `You've used your free credits. Ask the user to upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) at ${links.upgradeUrl} ` +
    "to keep going, or to use their own Claude or ChatGPT subscription; do not retry until they have."
  );
}

// The 402 body every credit gate returns. `error` is an object (code/message)
// for the managed-agents API; sandbox routes historically used a string
// `error`, so callers there spread `legacyStringError()` instead.
export function insufficientCreditsError(request: Request, plan?: UsagePlan | null) {
  const links = billingLinks(request);
  return {
    code: "insufficient_credits" as const,
    message: insufficientCreditsMessage(links, plan),
    actionUrl: plan === "max" ? links.billingUrl : links.upgradeUrl,
    ...links,
  };
}

export function insufficientCreditsResponse(request: Request, plan?: UsagePlan | null): Response {
  return Response.json({ error: insufficientCreditsError(request, plan) }, { status: 402 });
}

// Sandbox-route flavour: keeps `error` a string (the `oc` Go CLI prints it
// verbatim) while adding the structured fields alongside for newer clients.
export function insufficientCreditsLegacyResponse(
  request: Request,
  extra: Record<string, unknown> = {},
  plan?: UsagePlan | null,
): Response {
  const e = insufficientCreditsError(request, plan);
  return Response.json(
    {
      error: e.message,
      code: e.code,
      actionUrl: e.actionUrl,
      billingUrl: e.billingUrl,
      upgradeUrl: e.upgradeUrl,
      ...extra,
    },
    { status: 402 },
  );
}

export interface CreditsStatus {
  usagePlan: UsagePlan;
  creditsRemainingCents: number;
  lowCreditThresholdCents: number;
  isLow: boolean;
  isHalted: boolean;
  billingUrl: string;
  upgradeUrl: string;
  // Plans shown to this org. `name` is the display name (`max` is "Pro").
  // The retired $20 plan is listed only for orgs already on it.
  plans: Array<{ id: "pro" | "max"; name: string; priceUsd: number; creditsUsd: number }>;
}

const PRO_OFFER = { id: "max", name: PLAN_DISPLAY_NAMES.max, priceUsd: UPGRADE_PLAN_PRICE_USD, creditsUsd: 2_000 } as const;
const LEGACY_PRO_OFFER = { id: "pro", name: PLAN_DISPLAY_NAMES.pro, priceUsd: 20, creditsUsd: 200 } as const;

// Kept for callers that list offers without an org: only the plan on sale.
export const USAGE_PLAN_OFFERS: CreditsStatus["plans"] = [PRO_OFFER];

export function usagePlanOffers(current: UsagePlan): CreditsStatus["plans"] {
  return current === "pro" ? [LEGACY_PRO_OFFER, PRO_OFFER] : [PRO_OFFER];
}

// GET /api/billing/credits — API-key authenticated credit status for the CLI.
// Re-syncs Autumn → D1 like the dashboard endpoint so a fresh upgrade clears a
// halt on the next CLI call too. Legacy (Stripe) orgs have no Autumn customer
// and get a 404 — clients treat that as "no credit meter".
export async function handleCreditsStatus(
  req: Request,
  env: AutumnSyncEnv & { AUTUMN_SECRET_KEY?: string },
  caller: { orgID: string },
): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) {
    return Response.json({ error: "autumn billing not configured" }, { status: 503 });
  }
  let r;
  try {
    r = await syncAutumnToD1(env as AutumnSyncEnv, caller.orgID);
  } catch (e) {
    console.error("billing/credits sync:", e);
    return Response.json({ error: "autumn unavailable" }, { status: 502 });
  }
  if (!r) return Response.json({ error: "no autumn customer for org" }, { status: 404 });
  const usagePlan = activeUsagePlan(r.customer);
  const creditsRemainingCents = Math.max(0, Math.round(r.creditsRemaining * 100));
  const threshold = lowCreditThresholdCents(usagePlan);
  const links = billingLinks(req);
  const status: CreditsStatus = {
    usagePlan,
    creditsRemainingCents,
    lowCreditThresholdCents: threshold,
    isLow: !r.halted && creditsRemainingCents <= threshold,
    isHalted: r.halted,
    ...links,
    plans: usagePlanOffers(usagePlan),
  };
  return Response.json(status);
}
