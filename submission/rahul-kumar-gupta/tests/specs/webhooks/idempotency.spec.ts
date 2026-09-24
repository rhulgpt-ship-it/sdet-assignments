import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Mandatory: the provider may redeliver the same event. For a given event_id the effect must
 * happen exactly once — one transition, one audit entry, one notification, no extra invoice,
 * no provider call — while every redelivery is still acknowledged (200) and counted.
 */
describe('Webhook idempotency (duplicate event_id)', () => {
  const t = useTestEnvironment();

  it('same payment.succeeded delivered twice: transition happens exactly once', async () => {
    const { given, webhooks, verify, notifier, provider } = t.env;
    const g = await given.trialingWithUnknownCharge();
    const callsBefore = provider.calls.length;
    const event = aWebhook().paymentSucceeded().forInvoice(g.invoice!);

    const [first, second] = await webhooks.deliverRepeatedly(event, 2);

    expect(first).toMatchObject({ status: 200, body: { event_id: event.eventId, outcome: 'applied' } });
    expect(second).toMatchObject({ status: 200, body: { event_id: event.eventId, outcome: 'duplicate' } });

    await verify.expectStatus(g.subscription.id, 'active');
    verify.expectStatusHistory(g.subscription.id, ['trialing', 'active']);
    verify.expectInvoices(g.subscription.id, [{ id: g.invoice!.id, status: 'paid' }]);
    // Stored once, outcome of the first (real) processing kept, redelivery counted.
    verify.expectWebhookEvent(event.eventId, { outcome: 'applied', delivery_count: 2 });
    expect(t.env.repos.webhookEvents.findBySubscription(g.subscription.id)).toHaveLength(1);
    expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated']);
    expect(provider.calls).toHaveLength(callsBefore);
  });

  it('same payment.failed delivered five times: one past_due transition, one failed attempt, one notification', async () => {
    const { given, webhooks, verify, notifier } = t.env;
    const g = await given.activeWithUnknownRenewal();
    const event = aWebhook().paymentFailed('insufficient_funds').forInvoice(g.invoice!);

    const responses = await webhooks.deliverRepeatedly(event, 5);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(responses.map((r) => r.body.outcome)).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    await verify.expectStatus(g.subscription.id, 'past_due');
    verify.expectStatusHistory(g.subscription.id, ['trialing', 'active', 'past_due']);
    verify.expectInvoices(g.subscription.id, [
      { status: 'paid', attempt: 1 },
      { id: g.invoice!.id, status: 'failed', failure_code: 'insufficient_funds', attempt: 1 },
    ]);
    verify.expectWebhookEvent(event.eventId, { outcome: 'applied', delivery_count: 5 });
    expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated', 'subscription.past_due']);
  });

  it('a duplicate arriving after the subscription moved on does not replay the old effect', async () => {
    const { given, webhooks, verify, api } = t.env;
    const g = await given.trialingWithUnknownCharge();
    const activation = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
    await webhooks.deliver(activation);
    await api.cancelSubscription(g.subscription.id);
    const before = verify.snapshot(g.subscription.id);

    const res = await webhooks.deliver(activation);

    expect(res.body.outcome).toBe('duplicate');
    await verify.expectStatus(g.subscription.id, 'canceled');
    expect(verify.snapshot(g.subscription.id)).toEqual({
      ...before,
      webhookEvents: [expect.objectContaining({ event_id: activation.eventId, outcome: 'applied', delivery_count: 2 })],
    });
  });

  it('a duplicate refund is recorded once and refunds once', async () => {
    const { given, webhooks, verify, repos } = t.env;
    const g = await given.active();
    const refund = aWebhook().paymentRefunded().forInvoice(g.invoice!);

    await webhooks.deliverRepeatedly(refund, 3);

    verify.expectWebhookEvent(refund.eventId, { outcome: 'applied', delivery_count: 3 });
    verify.expectInvoices(g.subscription.id, [{ status: 'refunded' }]);
    expect(repos.audit.findBySubscription(g.subscription.id).filter((a) => a.kind === 'invoice_refunded')).toHaveLength(1);
  });

  it('two DIFFERENT event ids for the same invoice are not duplicates, but only the first can settle it', async () => {
    const { given, webhooks, verify } = t.env;
    const g = await given.trialingWithUnknownCharge();
    const first = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
    const second = aWebhook().paymentSucceeded().forInvoice(g.invoice!); // provider re-sent with a new id

    await webhooks.deliver(first);
    const res = await webhooks.deliver(second);

    expect(res.body.outcome).toBe('ignored_invoice_already_settled');
    verify.expectWebhookEvent(first.eventId, { outcome: 'applied' });
    verify.expectWebhookEvent(second.eventId, { outcome: 'ignored_invoice_already_settled' });
    verify.expectStatusHistory(g.subscription.id, ['trialing', 'active']);
    verify.expectInvoices(g.subscription.id, [{ status: 'paid' }]);
  });

  it('bonus: the same event delivered concurrently is still applied exactly once', async () => {
    const { given, webhooks, verify, notifier } = t.env;
    const g = await given.trialingWithUnknownCharge();
    const event = aWebhook().paymentSucceeded().forInvoice(g.invoice!);

    const responses = await webhooks.deliverConcurrently([event, event, event, event]);

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect(responses.filter((r) => r.body.outcome === 'duplicate')).toHaveLength(3);
    verify.expectWebhookEvent(event.eventId, { outcome: 'applied', delivery_count: 4 });
    expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated']);
  });
});
