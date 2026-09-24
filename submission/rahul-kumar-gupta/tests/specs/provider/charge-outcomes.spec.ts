import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { ProviderVerifier } from '../../support/verify/ProviderVerifier';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * The payment provider is mocked behind the PaymentProvider interface. These tests assert what
 * was SENT (count and exact arguments) and how the service reacts to success, decline and timeout.
 */
describe('Mocked payment provider: interaction and outcomes', () => {
  const t = useTestEnvironment();

  const createPro = async () => {
    const customer = t.env.seedCustomer();
    const res = await t.env.api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('pro').build());
    return { customer, res };
  };

  describe('success', () => {
    it('sends exactly one charge with customer, payment method, plan amount, currency, idempotency key and reference', async () => {
      const { provider, repos } = t.env;
      provider.willSucceed();
      const { customer, res } = await createPro();

      const invoice = repos.invoices.latestForSubscription(res.body.id)!;
      expect(provider.charge).toHaveBeenCalledTimes(1);
      expect(provider.charge).toHaveBeenCalledWith({
        customerId: customer.customer.id,
        paymentMethodId: customer.defaultPaymentMethodId,
        amount: 4900,
        currency: 'USD',
        idempotencyKey: `charge_${invoice.id}`,
        reference: invoice.id,
      });
      expect(invoice).toMatchObject({ status: 'paid', provider_charge_id: expect.stringMatching(/^ch_mock_/) });
    });
  });

  describe('decline', () => {
    it('moves to past_due (not active, not canceled), records the failure and schedules a retry', async () => {
      const { provider, verify, notifier, clock } = t.env;
      provider.willDecline('insufficient_funds');

      const { res } = await createPro();

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('past_due');
      await verify.expectStatus(res.body.id, 'past_due');
      verify.expectInvoices(res.body.id, [
        { status: 'failed', failure_code: 'insufficient_funds', paid_at: null, provider_charge_id: null, attempt: 1 },
      ]);
      expect(res.body.next_retry_at).toBe(new Date(clock.now().getTime() + t.env.billingRules.retryIntervalMs).toISOString());
      expect(notifier.for(res.body.id)).toEqual(['subscription.past_due']);
      expect(provider.calls).toHaveLength(1);
    });

    it('every retry is a new attempt with its own idempotency key, one call each, until retries are exhausted', async () => {
      const { api, given, provider, clock, verify } = t.env;
      const g = await given.pastDue();
      provider.alwaysDecline();

      for (let i = 0; i < t.env.billingRules.maxRetries; i += 1) {
        const sub = (await api.getSubscription(g.subscription.id)).body;
        clock.advanceTo(sub.next_retry_at!);
        await api.runBilling();
      }

      const invoices = verify.expectInvoices(g.subscription.id, [
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'failed' },
        { attempt: 3, status: 'failed' },
        { attempt: 4, status: 'failed' },
      ]);
      expect(provider.calls).toEqual(invoices.map((inv) => ProviderVerifier.expectedRequest(g.subscription, inv)));
      expect(new Set(provider.calls.map((c) => c.idempotencyKey)).size).toBe(4);
      await verify.expectStatus(g.subscription.id, 'canceled');
    });
  });

  describe('timeout (outcome unknown)', () => {
    it('leaves the attempt pending and the status unchanged, with no notification', async () => {
      const { provider, verify, notifier } = t.env;
      provider.willTimeout();

      const { res } = await createPro();

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('trialing');
      expect(res.body.latest_invoice).toMatchObject({ status: 'pending' });
      verify.expectInvoices(res.body.id, [{ status: 'pending', paid_at: null, failure_code: null }]);
      verify.expectStatusHistory(res.body.id, ['trialing']);
      expect(notifier.for(res.body.id)).toEqual([]);
    });

    it('the next billing run re-sends the SAME attempt with the SAME idempotency key (no new invoice)', async () => {
      const { api, provider, verify } = t.env;
      provider.willTimeout().willSucceed();
      const { res } = await createPro();

      await api.runBilling();

      const [invoice] = verify.expectInvoices(res.body.id, [{ status: 'paid', attempt: 1 }]);
      const expected = ProviderVerifier.expectedRequest(res.body, invoice);
      expect(provider.calls).toEqual([expected, expected]);
      await verify.expectStatus(res.body.id, 'active');
    });

    it('if the provider DID charge before timing out, the same-key re-send returns that charge instead of charging again', async () => {
      const { api, provider, verify } = t.env;
      provider.willTimeout({ processedAs: 'succeeded' });
      const { res } = await createPro();
      const invoiceId = res.body.latest_invoice!.id;
      const key = `charge_${invoiceId}`;
      const captured = provider.processedResult(key);

      await api.runBilling();

      expect(provider.callsFor(invoiceId)).toHaveLength(2);
      expect(provider.processedResult(key)).toBe(captured); // one charge at the provider, not two
      verify.expectInvoices(res.body.id, [{ status: 'paid', provider_charge_id: (captured as { chargeId: string }).chargeId }]);
      await verify.expectStatus(res.body.id, 'active');
    });

    it('a pending attempt blocks any NEW attempt: renewal is not charged while the previous outcome is unknown', async () => {
      const { api, given, provider, clock, repos } = t.env;
      const g = await given.activeWithUnknownRenewal();
      provider.willTimeout(); // the re-send times out again
      const invoicesBefore = repos.invoices.findBySubscription(g.subscription.id).length;

      clock.advanceDays(1);
      const run = await api.runBilling();

      expect(run.body.results).toEqual([
        { subscription_id: g.subscription.id, invoice_id: g.invoice!.id, reason: 'resolve_unknown', result: 'unknown' },
      ]);
      expect(repos.invoices.findBySubscription(g.subscription.id)).toHaveLength(invoicesBefore);
    });

    it('webhook settles a timed-out charge; the service never re-sends it afterwards', async () => {
      const { api, given, provider, webhooks } = t.env;
      const g = await given.trialingWithUnknownCharge();
      await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(g.invoice!));

      await api.runBilling();

      expect(provider.callsFor(g.invoice!.id)).toHaveLength(1);
    });
  });

  describe('actions that must NOT call the provider', () => {
    it('GET, cancel and later billing runs never charge a trialing-then-canceled subscription', async () => {
      const { api, given, providerVerify, clock } = t.env;
      const g = await given.trialing();

      await api.getSubscription(g.subscription.id);
      await api.cancelSubscription(g.subscription.id);
      clock.advanceDays(60);
      await api.runBilling();

      providerVerify.expectNoCharges();
    });

    it('replaying an already-processed webhook never triggers a charge', async () => {
      const { api, given, provider, webhooks } = t.env;
      const g = await given.trialingWithUnknownCharge();
      const settle = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
      await webhooks.deliver(settle);
      const callsBefore = provider.calls.length;

      await webhooks.deliverRepeatedly(settle, 3);
      await api.runBilling();

      expect(provider.calls).toHaveLength(callsBefore);
    });
  });
});
