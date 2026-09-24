import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Webhooks arrive late and out of order. Rule under test: an event can only settle an attempt
 * that is still pending, and can never act on a canceled subscription. Everything else is
 * recorded with an "ignored_*" outcome and has no other effect.
 */
describe('Out-of-order and stale webhook delivery', () => {
  const t = useTestEnvironment();

  it('payment.failed arriving AFTER payment.succeeded for the same invoice does not regress active', async () => {
    const { given, webhooks, verify, notifier } = t.env;
    const g = await given.trialingWithUnknownCharge();
    await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(g.invoice!));
    const before = verify.snapshot(g.subscription.id);

    const late = aWebhook().paymentFailed().forInvoice(g.invoice!);
    const res = await webhooks.deliver(late);

    expect(res.body.outcome).toBe('ignored_invoice_already_settled');
    await verify.expectStatus(g.subscription.id, 'active');
    const after = verify.snapshot(g.subscription.id);
    expect(after.subscription).toEqual(before.subscription);
    expect(after.invoices).toEqual(before.invoices); // still paid, no failure_code
    expect(after.audit).toEqual(before.audit);
    expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated']);
  });

  it('a late confirmation of a charge the billing run already recorded is a no-op', async () => {
    const { given, webhooks, verify } = t.env;
    const g = await given.active(); // billing run saw the success synchronously
    const before = verify.snapshot(g.subscription.id);

    const confirmation = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
    const res = await webhooks.deliver(confirmation);

    expect(res.body.outcome).toBe('ignored_invoice_already_settled');
    expect(verify.snapshot(g.subscription.id).audit).toEqual(before.audit);
    expect(verify.snapshot(g.subscription.id).invoices).toEqual(before.invoices);
  });

  it('a stale event for an OLDER attempt does not affect the attempt currently in flight', async () => {
    const { given, webhooks, verify, repos } = t.env;
    const g = await given.pastDueWithUnknownRetry(); // attempt 1 failed, attempt 2 pending
    const [attempt1, attempt2] = repos.invoices.findBySubscription(g.subscription.id);

    const stale = await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(attempt1));
    expect(stale.body.outcome).toBe('ignored_invoice_already_settled');
    await verify.expectStatus(g.subscription.id, 'past_due');

    // The real outcome for attempt 2 still applies afterwards.
    const current = await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(attempt2));
    expect(current.body.outcome).toBe('applied');
    await verify.expectStatus(g.subscription.id, 'active');
    verify.expectInvoices(g.subscription.id, [
      { id: attempt1.id, status: 'failed', attempt: 1 },
      { id: attempt2.id, status: 'paid', attempt: 2 },
    ]);
  });

  it('refund arriving before the success it refunds is ignored; the success still applies', async () => {
    const { given, webhooks, verify } = t.env;
    const g = await given.trialingWithUnknownCharge();

    const earlyRefund = await webhooks.deliver(aWebhook().paymentRefunded().forInvoice(g.invoice!));
    expect(earlyRefund.body.outcome).toBe('ignored_invoice_already_settled');

    const success = await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(g.invoice!));
    expect(success.body.outcome).toBe('applied');
    await verify.expectStatus(g.subscription.id, 'active');
    verify.expectInvoices(g.subscription.id, [{ status: 'paid' }]);
  });

  it('webhook resolves an unknown charge first; the later same-key re-send does not double-apply', async () => {
    const { given, webhooks, verify, api, provider } = t.env;
    const g = await given.trialingWithUnknownCharge();
    await webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(g.invoice!));

    // Nothing is pending any more, so the next billing run has nothing to re-send.
    const run = await api.runBilling();

    expect(run.body.results).toEqual([]);
    expect(provider.callsFor(g.invoice!.id)).toHaveLength(1);
    verify.expectStatusHistory(g.subscription.id, ['trialing', 'active']);
  });

  it('bonus: success and failure for different attempts racing each other leave a legal, consistent state', async () => {
    const { given, webhooks, verify, repos } = t.env;
    const g = await given.pastDueWithUnknownRetry();
    const [attempt1, attempt2] = repos.invoices.findBySubscription(g.subscription.id);

    const responses = await webhooks.deliverConcurrently([
      aWebhook().paymentSucceeded().forInvoice(attempt2),
      aWebhook().paymentFailed().forInvoice(attempt1),
      aWebhook().paymentSucceeded().forInvoice(attempt1),
    ]);

    expect(responses.map((r) => r.body.outcome).sort()).toEqual(
      ['applied', 'ignored_invoice_already_settled', 'ignored_invoice_already_settled'].sort(),
    );
    await verify.expectStatus(g.subscription.id, 'active');
    // The afterEach invariant check additionally proves audit path, notifications and provider calls agree.
  });
});
