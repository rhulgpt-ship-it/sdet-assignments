import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Persisted state is checked at EVERY stage of a lifecycle, not just after creation:
 * subscription row, each billing attempt, the audit trail and processed webhook events —
 * and each checkpoint also confirms the API reports exactly the persisted row.
 */
describe('Persistence across the lifecycle', () => {
  const t = useTestEnvironment();

  it('basic plan: create -> activate -> renew -> fail renewal -> webhook-settled retry -> cancel', async () => {
    const { api, seedCustomer, provider, clock, verify, repos, webhooks } = t.env;
    const customer = seedCustomer();

    // 1. create (trialing)
    const created = await api.createSubscription({ customer_id: customer.customer.id, plan: 'basic', payment_method_id: customer.defaultPaymentMethodId });
    const id = created.body.id;
    expect(repos.subscriptions.find(id)).toMatchObject({
      status: 'trialing', plan: 'basic', customer_id: customer.customer.id,
      created_at: '2026-01-01T00:00:00.000Z', trial_ends_at: '2026-01-15T00:00:00.000Z',
      current_period_start: null, current_period_end: null, canceled_at: null,
    });
    verify.expectInvoices(id, []);
    verify.expectStatusHistory(id, ['trialing']);
    await verify.expectApiMatchesDatabase(id);

    // 2. trial ends, first charge succeeds (active)
    clock.advanceTo('2026-01-15T00:00:00.000Z');
    provider.willSucceed();
    await api.runBilling();
    expect(repos.subscriptions.find(id)).toMatchObject({
      status: 'active', current_period_start: '2026-01-15T00:00:00.000Z', current_period_end: '2026-02-14T00:00:00.000Z',
      next_retry_at: null, updated_at: '2026-01-15T00:00:00.000Z',
    });
    verify.expectInvoices(id, [
      { attempt: 1, amount: 1900, status: 'paid', paid_at: '2026-01-15T00:00:00.000Z', created_at: '2026-01-15T00:00:00.000Z' },
    ]);
    verify.expectStatusHistory(id, ['trialing', 'active']);
    await verify.expectApiMatchesDatabase(id);

    // 3. renewal succeeds (still active, period rolls forward from the previous end, audit 'renewed')
    clock.advanceTo('2026-02-14T00:00:00.000Z');
    provider.willSucceed();
    await api.runBilling();
    expect(repos.subscriptions.find(id)).toMatchObject({
      status: 'active', current_period_start: '2026-02-14T00:00:00.000Z', current_period_end: '2026-03-16T00:00:00.000Z',
    });
    verify.expectInvoices(id, [{ status: 'paid' }, { attempt: 1, status: 'paid', paid_at: '2026-02-14T00:00:00.000Z' }]);
    expect(repos.audit.findBySubscription(id).map((a) => a.kind)).toEqual(['created', 'transition', 'renewed']);
    await verify.expectApiMatchesDatabase(id);

    // 4. next renewal declined (past_due, retry scheduled one day later)
    clock.advanceTo('2026-03-16T00:00:00.000Z');
    provider.willDecline('expired_card');
    await api.runBilling();
    expect(repos.subscriptions.find(id)).toMatchObject({ status: 'past_due', next_retry_at: '2026-03-17T00:00:00.000Z' });
    verify.expectInvoices(id, [{ status: 'paid' }, { status: 'paid' }, { attempt: 1, status: 'failed', failure_code: 'expired_card', paid_at: null }]);
    verify.expectStatusHistory(id, ['trialing', 'active', 'past_due']);
    await verify.expectApiMatchesDatabase(id);

    // 5. retry times out, then the provider confirms it by webhook (active again)
    clock.advanceTo('2026-03-17T00:00:00.000Z');
    provider.willTimeout();
    await api.runBilling();
    const retry = repos.invoices.latestForSubscription(id)!;
    expect(retry).toMatchObject({ attempt: 2, status: 'pending' });
    expect(repos.subscriptions.find(id)!.status).toBe('past_due');
    clock.advanceMinutes(5);
    const confirm = aWebhook().paymentSucceeded('ch_provider_777').forInvoice(retry);
    await webhooks.deliver(confirm);
    expect(repos.invoices.find(retry.id)).toMatchObject({ status: 'paid', provider_charge_id: 'ch_provider_777', paid_at: '2026-03-17T00:05:00.000Z' });
    expect(repos.subscriptions.find(id)).toMatchObject({ status: 'active', next_retry_at: null, current_period_start: '2026-03-17T00:05:00.000Z' });
    verify.expectWebhookEvent(confirm.eventId, { outcome: 'applied' });
    expect(repos.audit.findBySubscription(id).pop()).toMatchObject({ source: 'webhook', source_ref: confirm.eventId, to_status: 'active' });
    await verify.expectApiMatchesDatabase(id);

    // 6. customer cancels (terminal, canceled_at = now)
    clock.advanceDays(2);
    await api.cancelSubscription(id);
    expect(repos.subscriptions.find(id)).toMatchObject({ status: 'canceled', canceled_at: clock.now().toISOString(), next_retry_at: null });
    verify.expectStatusHistory(id, ['trialing', 'active', 'past_due', 'active', 'canceled']);
    verify.expectInvoices(id, [{ status: 'paid' }, { status: 'paid' }, { status: 'failed' }, { status: 'paid', attempt: 2 }]);
    await verify.expectApiMatchesDatabase(id);
  });

  it('cancel voids an in-flight attempt so it can never be settled later', async () => {
    const { api, given, verify, repos } = t.env;
    const g = await given.trialingWithUnknownCharge();

    await api.cancelSubscription(g.subscription.id);

    verify.expectInvoices(g.subscription.id, [{ id: g.invoice!.id, status: 'void', paid_at: null }]);
    expect(repos.invoices.findPendingBySubscription(g.subscription.id)).toEqual([]);
  });

  it('records from other subscriptions never leak into a subscription\'s view (scoping, no false positives)', async () => {
    const { given, verify, repos } = t.env;
    const a = await given.active();
    const b = await given.pastDue();

    verify.expectInvoices(a.subscription.id, [{ status: 'paid', subscription_id: a.subscription.id }]);
    verify.expectInvoices(b.subscription.id, [{ status: 'failed', subscription_id: b.subscription.id }]);
    expect(repos.invoices.findAll()).toHaveLength(2); // positive control: both rows exist in the table
  });
});
