import { BasicPlan, PlanRegistry, ProPlan } from '../../../src/domain/plans/PlanPolicy';

describe('PlanPolicy strategies', () => {
  const created = new Date('2026-01-01T00:00:00.000Z');

  it('basic: 1900 USD, 14-day trial, not charged at creation', () => {
    const plan = new BasicPlan();
    expect(plan).toMatchObject({ code: 'basic', priceMinor: 1900, currency: 'USD', trialDays: 14 });
    expect(plan.chargesImmediately()).toBe(false);
    expect(plan.trialEndsAt(created).toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('pro: 4900 USD, no trial, charged at creation', () => {
    const plan = new ProPlan();
    expect(plan).toMatchObject({ code: 'pro', priceMinor: 4900, currency: 'USD', trialDays: 0 });
    expect(plan.chargesImmediately()).toBe(true);
    expect(plan.trialEndsAt(created).toISOString()).toBe(created.toISOString());
  });

  it('billing periods are 30 days for every plan', () => {
    for (const plan of new PlanRegistry().all()) {
      expect(plan.periodEndFrom(created).toISOString()).toBe('2026-01-31T00:00:00.000Z');
    }
  });

  it('registry resolves known plans and reports unknown ones', () => {
    const registry = new PlanRegistry();
    expect(registry.find('pro')).toBeInstanceOf(ProPlan);
    expect(registry.find('enterprise')).toBeUndefined();
    expect(() => registry.get('enterprise')).toThrow(/Unknown plan/);
  });
});
