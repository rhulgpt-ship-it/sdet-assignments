import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { ProviderVerifier } from '../../support/verify/ProviderVerifier';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/** Plan-specific behaviour: trial length and price, applied the same at creation and at billing. */
describe('Plan rules (PlanPolicy applied at creation and at billing)', () => {
  const t = useTestEnvironment();

  describe('basic: 14-day trial, 1900 USD', () => {
    it('starts trialing with trial_ends_at = created_at + 14 days and no charge', async () => {
      const { api, seedCustomer, providerVerify, verify } = t.env;
      const customer = seedCustomer();

      const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('basic').build());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'trialing',
        created_at: '2026-01-01T00:00:00.000Z',
        trial_ends_at: '2026-01-15T00:00:00.000Z',
        current_period_start: null,
        latest_invoice: null,
      });
      providerVerify.expectNoCharges();
      verify.expectInvoices(res.body.id, []);
    });

    it('is not charged one minute before the trial ends', async () => {
      const { api, given, clock, providerVerify } = t.env;
      const g = await given.trialing();

      clock.advanceTo(g.subscription.trial_ends_at!).advanceMinutes(-1);
      const run = await api.runBilling();

      expect(run.body.results).toEqual([]);
      providerVerify.expectNoCharges();
    });

    it('is charged exactly the plan price when the trial ends', async () => {
      const { api, given, clock, provider, verify } = t.env;
      const g = await given.trialing();

      clock.advanceTo(g.subscription.trial_ends_at!);
      await api.runBilling();

      const [invoice] = verify.expectInvoices(g.subscription.id, [{ amount: 1900, currency: 'USD', attempt: 1, status: 'paid' }]);
      expect(provider.calls).toEqual([ProviderVerifier.expectedRequest(g.subscription, invoice)]);
      const sub = (await api.getSubscription(g.subscription.id)).body;
      expect(sub).toMatchObject({
        status: 'active',
        current_period_start: '2026-01-15T00:00:00.000Z',
        current_period_end: '2026-02-14T00:00:00.000Z',
      });
    });
  });

  describe('pro: no trial, 4900 USD charged at creation', () => {
    it('charges 4900 USD inside the create request and returns active', async () => {
      const { api, seedCustomer, provider, verify } = t.env;
      const customer = seedCustomer();

      const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('pro').build());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'active', trial_ends_at: res.body.created_at });
      const [invoice] = verify.expectInvoices(res.body.id, [{ amount: 4900, currency: 'USD', status: 'paid', attempt: 1 }]);
      expect(res.body.latest_invoice).toEqual({ id: invoice.id, amount: 4900, currency: 'USD', status: 'paid', attempt: 1 });
      expect(provider.calls).toEqual([ProviderVerifier.expectedRequest(res.body, invoice)]);
      // Even a zero-day trial goes through the state machine: trialing -> active.
      verify.expectStatusHistory(res.body.id, ['trialing', 'active']);
    });

    it('bills renewals at the same 4900 USD', async () => {
      const { api, given, clock, verify } = t.env;
      const g = await given.activePro();

      clock.advanceTo(g.subscription.current_period_end!);
      await api.runBilling();

      verify.expectInvoices(g.subscription.id, [
        { amount: 4900, status: 'paid', attempt: 1 },
        { amount: 4900, status: 'paid', attempt: 1 },
      ]);
      await verify.expectStatus(g.subscription.id, 'active');
    });
  });
});
