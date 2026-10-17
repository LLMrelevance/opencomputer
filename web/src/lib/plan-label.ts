// Display names of the Autumn usage plans. `max` ($200/mo) is sold as "Pro";
// the retired $20/mo plan (id `pro`) is "Pro (legacy)" for its subscribers.
export const USAGE_PLAN_NAMES: Record<'base' | 'pro' | 'max', string> = {
  base: 'Free',
  pro: 'Pro (legacy)',
  max: 'Pro',
}

export function usagePlanLabel(plan: string): string {
  return plan === 'base' || plan === 'pro' || plan === 'max'
    ? USAGE_PLAN_NAMES[plan]
    : planLabel(plan)
}

export function planLabel(plan: string): string {
  return plan
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

type PlanSource = {
  plan: string
}

type BillingPlanSource = PlanSource & {
  billingProvider?: string
}

type AutumnPlanSource = {
  usagePlan: string
}

export function organizationPlanLabel(
  org: PlanSource | undefined,
  billing: BillingPlanSource | undefined,
  autumn: AutumnPlanSource | undefined,
): string {
  if (billing?.billingProvider === 'autumn') {
    return usagePlanLabel(autumn?.usagePlan ?? 'base')
  }

  return planLabel(billing?.plan ?? org?.plan ?? 'free')
}
