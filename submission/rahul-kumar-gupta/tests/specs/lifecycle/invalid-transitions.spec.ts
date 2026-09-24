import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Transitions NOT in the table must be impossible through every entry point.
 * Each test proves both the visible response AND that nothing was persisted, charged or notified
 * (a "safely ignored" event is recorded in webhook_events with its outcome, and nothing else).
 */
describe('Lifecycle: invalid transitions are impossible', () => {
  const t = useTestEnvironment();

  describe('canceled is terminal', () => {
    it('canceled -> active: a late payment.succeeded for an in-flight charge does not reactivate', async () => {
      const { api, given, webhooks, verify, notifier } = t.env;
      // Trial-end charge timed out, then the customer canceled (voiding the in-flight attempt).
      const g = await given.trialingWithUnknownCharge();
      await api.cancelSubscription(g.subscription.id);
      const before = verify.snapshot(g.subscription.id);

      const late = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
      const res = await webhooks.deliver(late);

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ignored_subscription_canceled');
      await verify.expectStatus(g.subscription.id, 'canceled');
      verify.expectWebhookEvent(late.eventId, { outcome: 'ignored_subscription_canceled' });
      const after = verify.snapshot(g.subscription.id);
      expect(after.invoices).toEqual(before.invoices); // still 'void', no paid_at
      expect(after.audit).toEqual(before.audit);
      expect(notifier.for(g.subscription.id)).toEqual(['subscription.canceled']);
    });

    it('canceled -> past_due: a stray payment.failed after cancel is ignored', async () => {
      const { given, webhooks, verify } = t.env;
      const g = await given.canceled();
      const before = verify.snapshot(g.subscription.id);

      const stray = aWebhook().paymentFailed().forInvoice(g.invoice!);
      const res = await webhooks.deliver(stray);

      expect(res.body.outcome).toBe('ignored_subscription_canceled');
      await verify.expectStatus(g.subscription.id, 'canceled');
      expect(verify.snapshot(g.subscription.id)).toEqual({
        ...before,
        webhookEvents: [expect.objectContaining({ event_id: stray.eventId, outcome: 'ignored_subscription_canceled' })],
      });
    });

    it('canceled subscriptions are never billed again, however much time passes', async () => {
      const { api, given, provider, clock } = t.env;
      await given.canceled();
      const callsBefore = provider.calls.length;

      clock.advanceDays(120);
      const run = await api.runBilling();

      expect(run.body.results).toEqual([]);
      expect(provider.calls).toHaveLength(callsBefore);
    });

    it('canceled -> canceled: canceling twice is rejected with 409 and changes nothing', async () => {
      const { api, given, verify, notifier } = t.env;
      const g = await given.canceled();
      const before = verify.snapshot(g.subscription.id);

      const res = await api.cancelSubscription(g.subscription.id);

      expect(res.status).toBe(409);
      expect(res.error?.code).toBe('subscription_already_canceled');
      verify.expectUnchangedSince(before);
      expect(notifier.for(g.subscription.id).filter((n) => n === 'subscription.canceled')).toHaveLength(1);
    });
  });

  it('past_due -> canceled via the API is not in the diagram and is rejected with 409', async () => {
    const { api, given, verify, provider } = t.env;
    const g = await given.pastDue();
    const before = verify.snapshot(g.subscription.id);
    const callsBefore = provider.calls.length;

    const res = await api.cancelSubscription(g.subscription.id);

    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('illegal_transition');
    verify.expectUnchangedSince(before);
    expect(provider.calls).toHaveLength(callsBefore);
  });

  it('past_due -> active is impossible via a stale payment.succeeded for the already-failed attempt', async () => {
    const { given, webhooks, verify } = t.env;
    const g = await given.pastDue(); // attempt 1 failed
    const stale = aWebhook().paymentSucceeded().forInvoice(g.invoice!);

    const res = await webhooks.deliver(stale);

    expect(res.body.outcome).toBe('ignored_invoice_already_settled');
    await verify.expectStatus(g.subscription.id, 'past_due');
    verify.expectInvoices(g.subscription.id, [{ id: g.invoice!.id, status: 'failed', paid_at: null }]);
  });

  it('a refund defines no transition: payment.refunded settles the invoice but never moves status', async () => {
    const { given, webhooks, verify, notifier } = t.env;
    const g = await given.active();

    const refund = aWebhook().paymentRefunded().forInvoice(g.invoice!);
    const res = await webhooks.deliver(refund);

    expect(res.body.outcome).toBe('applied');
    await verify.expectStatus(g.subscription.id, 'active');
    verify.expectStatusHistory(g.subscription.id, ['trialing', 'active']);
    verify.expectInvoices(g.subscription.id, [{ id: g.invoice!.id, status: 'refunded' }]);
    const audit = t.env.repos.audit.findBySubscription(g.subscription.id);
    expect(audit[audit.length - 1]).toMatchObject({ kind: 'invoice_refunded', from_status: 'active', to_status: 'active', source_ref: refund.eventId });
    expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated']);
  });
});
