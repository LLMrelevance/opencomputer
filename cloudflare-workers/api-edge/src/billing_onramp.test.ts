import { describe, expect, it } from "vitest";
import {
  activeUsagePlan,
  billingLinks,
  FREE_CREDITS_PAYWALL,
  insufficientCreditsLegacyResponse,
  insufficientCreditsResponse,
  lowCreditThresholdCents,
  USAGE_PLAN_OFFERS,
  usagePlanOffers,
} from "./billing_onramp";
import type { AutumnCustomer } from "./autumn_webhook";

const req = new Request("https://app.opencomputer.dev/api/v3/sessions");

describe("billing_onramp", () => {
  it("low-credit threshold is 30% of the plan grant", () => {
    expect(lowCreditThresholdCents("base")).toBe(300);
    expect(lowCreditThresholdCents("pro")).toBe(6_000);
    expect(lowCreditThresholdCents("max")).toBe(60_000);
  });

  it("picks the highest active usage plan", () => {
    const customer = {
      subscriptions: [
        { plan_id: "pro", status: "active" },
        { plan_id: "max", status: "canceled" },
      ],
    } as unknown as AutumnCustomer;
    expect(activeUsagePlan(customer)).toBe("pro");
    expect(activeUsagePlan({} as AutumnCustomer)).toBe("base");
  });

  it("builds deep links off the request origin", () => {
    expect(billingLinks(req)).toEqual({
      billingUrl: "https://app.opencomputer.dev/billing",
      upgradeUrl: "https://app.opencomputer.dev/billing?plan=max",
    });
  });

  it("402 body carries a stable code, do-not-retry hint and upgrade url", async () => {
    const res = insufficientCreditsResponse(req);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("insufficient_credits");
    expect(body.error.message).toMatch(/do not retry/);
    expect(body.error.message).toContain("You've used your free credits.");
    expect(body.error.message).toContain(
      "upgrade to Pro ($200/mo) at https://app.opencomputer.dev/billing?plan=max",
    );
    expect(body.error.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
    expect(body.error.actionUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
  });

  it("never offers top-ups or the retired $20 plan in any 402", async () => {
    for (const plan of [undefined, "base", "pro", "max"] as const) {
      const body = (await insufficientCreditsResponse(req, plan).json()) as {
        error: Record<string, string>;
      };
      expect(body.error.message).not.toMatch(/top.?up|\$20\b|plan=pro/i);
      expect(body.error.upgradeUrl).not.toContain("plan=pro");
    }
  });

  it("points a legacy $20 Pro org at the $200 Pro, and does not upsell a $200 Pro org", async () => {
    const legacy = (await insufficientCreditsResponse(req, "pro").json()) as {
      error: Record<string, string>;
    };
    expect(legacy.error.message).toContain("upgrade to Pro ($200/mo) at https://app.opencomputer.dev/billing?plan=max");
    const max = (await insufficientCreditsResponse(req, "max").json()) as {
      error: Record<string, string>;
    };
    expect(max.error.message).not.toMatch(/upgrade/i);
    expect(max.error.actionUrl).toBe("https://app.opencomputer.dev/billing");
  });

  it("offers only the $200 Pro, listing legacy Pro to its own subscribers", () => {
    expect(USAGE_PLAN_OFFERS).toEqual([{ id: "max", name: "Pro", priceUsd: 200, creditsUsd: 2_000 }]);
    expect(usagePlanOffers("base").map((p) => p.id)).toEqual(["max"]);
    expect(usagePlanOffers("max").map((p) => p.id)).toEqual(["max"]);
    expect(usagePlanOffers("pro").map((p) => [p.id, p.name])).toEqual([
      ["pro", "Pro (legacy)"],
      ["max", "Pro"],
    ]);
  });

  it("paywall copy names Pro and BYO subscriptions but not the grant amount", () => {
    expect(FREE_CREDITS_PAYWALL).toBe(
      "You've used your free credits. Upgrade to Pro ($200/mo) to keep going.",
    );
  });

  it("legacy sandbox 402 keeps `error` a string and adds structured fields", async () => {
    const res = insufficientCreditsLegacyResponse(req, { creditsRemainingCents: 0 });
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("insufficient_credits");
    expect(body.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
    expect(body.creditsRemainingCents).toBe(0);
  });
});
