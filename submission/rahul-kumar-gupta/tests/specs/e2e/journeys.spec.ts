import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { ProviderVerifier } from '../../support/verify/ProviderVerifier';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * End-to-end: API request / billing run / webhook -> service -> persistence -> provider, with
 * API + DB + provider + side effects checked at each step of realistic, messy journeys.
 */
describe('End-to-end journeys', () => {
  const t = useTestEnvironment();

  it('pro: declined at signup -> retry succeeds -> cancel -> stray and duplicate webhooks change nothing', async () => {
    const { api, seedCustomer, provider, clock, verify, webhooks, notifier, repos } = t.env;
    const customer = seedCustomer();

    // Signup: immediate charge declined.
    provider.willDecline('insufficient_funds');
    const created = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('pro').build());
    const id = created.body.id;
    expect(created.body.status).toBe('past_due');
    const [attempt1] = verify.expectInvoices(id, [{ attempt: 1, status: 'failed' }]);
    expect(provider.calls).toEqual([ProviderVerifier.expectedRequest(created.body, attempt1)]);

    // Provider also sends the failure webhook (normal behaviour) -> already settled, no second transition.
    const failedEvt = aWebhook().paymentFailed('insufficient_funds').forInvoice(attempt1);
    expect((await webhooks.deliver(failedEvt)).body.outcome).toBe('ignored_invoice_already_settled');

    // Retry next day succeeds.
    clock.advanceTo(created.body.next_retry_at!);
    provider.willSucceed();
    await api.runBilling();
    await verify.expectStatus(id, 'active');
    const [, attempt2] = verify.expectInvoices(id, [{ status: 'failed' }, { attempt: 2, status: 'paid' }]);
    expect(provider.calls[1]).toEqual(ProviderVerifier.expectedRequest(created.body, attempt2));

    // Customer cancels.
    clock.advanceDays(10);
    expect((await api.cancelSubscription(id)).body.status).toBe('canceled');

    // Stray success for the old failed attempt, and a replay of the earlier failure event.
    const stray = aWebhook().paymentSucceeded().forInvoice(attempt1);
    expect((await webhooks.deliver(stray)).body.outcome).toBe('ignored_subscription_canceled');
    expect((await webhooks.deliver(failedEvt)).body.outcome).toBe('duplicate');

    // Months later the billing run does nothing for this customer.
    clock.advanceDays(90);
    await api.runBilling();

    await verify.expectStatus(id, 'canceled');
    verify.expectStatusHistory(id, ['trialing', 'past_due', 'active', 'canceled']);
    expect(provider.calls).toHaveLength(2);
    expect(notifier.for(id)).toEqual(['subscription.past_due', 'subscription.activated', 'subscription.canceled']);
    expect(repos.webhookEvents.findBySubscription(id).map((e) => [e.outcome, e.delivery_count])).toEqual([
      ['ignored_invoice_already_settled', 2],
      ['ignored_subscription_canceled', 1],
    ]);
  });

  it('basic: dunning with every retry outcome arriving by webhook, including a duplicate, until canceled', async () => {
    const { api, given, provider, clock, verify, webhooks, repos, notifier } = t.env;
    const g = await given.pastDue(); // attempt 1 declined synchronously
    const id = g.subscription.id;

    // Every retry times out at the API level; the provider reports failure by webhook.
    for (let attempt = 2; attempt <= 1 + t.env.billingRules.maxRetries; attempt += 1) {
      const sub = (await api.getSubscription(id)).body;
      clock.advanceTo(sub.next_retry_at!);
      provider.willTimeout();
      await api.runBilling();
      const pending = repos.invoices.latestForSubscription(id)!;
      expect(pending).toMatchObject({ attempt, status: 'pending' });

      clock.advanceMinutes(1);
      const failed = aWebhook().paymentFailed().forInvoice(pending);
      await webhooks.deliverRepeatedly(failed, 2); // provider redelivers each one
      verify.expectWebhookEvent(failed.eventId, { outcome: 'applied', delivery_count: 2 });
    }

    await verify.expectStatus(id, 'canceled');
    verify.expectStatusHistory(id, ['trialing', 'past_due', 'canceled']);
    verify.expectInvoices(id, [1, 2, 3, 4].map((attempt) => ({ attempt, status: 'failed' as const })));
    expect(provider.calls).toHaveLength(4);
    expect(notifier.for(id)).toEqual(['subscription.past_due', 'subscription.canceled']);
    const last = repos.audit.findBySubscription(id).pop()!;
    expect(last).toMatchObject({ trigger: 'retries_exhausted', source: 'webhook' });
  });

  it('two customers progressing at the same time never affect each other', async () => {
    const { given, provider, api, clock, verify, webhooks } = t.env;
    const a = await given.trialing();
    const b = await given.trialing();

    provider.willSucceed().willTimeout();
    clock.advanceTo(a.subscription.trial_ends_at!);
    await api.runBilling();

    await verify.expectStatus(a.subscription.id, 'active');
    await verify.expectStatus(b.subscription.id, 'trialing');

    const bInvoice = t.env.repos.invoices.latestForSubscription(b.subscription.id)!;
    await webhooks.deliver(aWebhook().paymentFailed().forInvoice(bInvoice));
    await verify.expectStatus(a.subscription.id, 'active');
    await verify.expectStatus(b.subscription.id, 'past_due');
  });
});
