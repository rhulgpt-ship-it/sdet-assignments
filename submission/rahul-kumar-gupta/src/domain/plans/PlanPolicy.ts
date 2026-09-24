/**
 * Strategy: each plan owns its pricing and trial rules.
 *
 * The same PlanPolicy object is used when a subscription is created (trial end, immediate charge)
 * and every time it is billed (amount, currency, period length), so "plan rules are applied
 * consistently between creation and billing" is true by construction and checkable in tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanPolicy {
  readonly code: string;
  /** Price per billing period in minor units (cents). */
  readonly priceMinor: number;
  readonly currency: string;
  readonly trialDays: number;
  readonly billingPeriodDays: number;

  /** True when the first charge happens inside the create request (no trial). */
  chargesImmediately(): boolean;
  trialEndsAt(createdAt: Date): Date;
  periodEndFrom(periodStart: Date): Date;
}

abstract class BasePlanPolicy implements PlanPolicy {
  abstract readonly code: string;
  abstract readonly priceMinor: number;
  abstract readonly trialDays: number;
  readonly currency: string = 'USD';
  readonly billingPeriodDays: number = 30;

  chargesImmediately(): boolean {
    return this.trialDays === 0;
  }

  trialEndsAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.trialDays * DAY_MS);
  }

  periodEndFrom(periodStart: Date): Date {
    return new Date(periodStart.getTime() + this.billingPeriodDays * DAY_MS);
  }
}

export class BasicPlan extends BasePlanPolicy {
  readonly code = 'basic';
  readonly priceMinor = 1900;
  readonly trialDays = 14;
}

export class ProPlan extends BasePlanPolicy {
  readonly code = 'pro';
  readonly priceMinor = 4900;
  readonly trialDays = 0;
}

export class PlanRegistry {
  private readonly plans: Map<string, PlanPolicy>;

  constructor(plans: PlanPolicy[] = [new BasicPlan(), new ProPlan()]) {
    this.plans = new Map(plans.map((p) => [p.code, p]));
  }

  find(code: string): PlanPolicy | undefined {
    return this.plans.get(code);
  }

  get(code: string): PlanPolicy {
    const plan = this.plans.get(code);
    if (!plan) throw new Error(`Unknown plan '${code}'`);
    return plan;
  }

  all(): PlanPolicy[] {
    return [...this.plans.values()];
  }
}
