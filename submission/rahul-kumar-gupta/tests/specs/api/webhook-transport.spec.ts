import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Webhook request handling, tested separately from webhook business logic.
 * Every rejected delivery must leave NO trace: no webhook_events row, no invoice change,
 * no status change, no notification. A pending charge is used as the target so a wrongly
 * accepted event would visibly settle it.
 */
describe('API contract: POST /webhooks/payment-provider (transport layer)', () => {
  const t = useTestEnvironment();

  async function pendingTarget() {
    const g = await t.env.given.trialingWithUnknownCharge();
    return { g, before: t.env.verify.snapshot(g.subscription.id) };
  }

  it('200 and applied for a correctly signed, well-formed event', async () => {
    const { g } = await pendingTarget();
    const event = aWebhook().paymentSucceeded().forInvoice(g.invoice!);

    const res = await t.env.webhooks.deliver(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: event.eventId, outcome: 'applied' });
  });

  it.each([
    ['no X-Provider-Signature header', 401, 'missing_signature', (e: ReturnType<typeof aWebhook>) => e.unsigned()],
    ['a forged signature', 401, 'invalid_signature', (e: ReturnType<typeof aWebhook>) => e.withForgedSignature()],
    ['a signature made with the wrong secret', 401, 'invalid_signature', (e: ReturnType<typeof aWebhook>) => e.signedWithSecret('whsec_attacker')],
    ['a body altered after signing', 401, 'invalid_signature', (e: ReturnType<typeof aWebhook>) => e.withTamperedBody()],
    ['a body that is not JSON', 400, 'malformed_payload', (e: ReturnType<typeof aWebhook>) => e.withRawBody('event_id=evt_1&type=payment.succeeded')],
    ['a JSON array body', 400, 'malformed_payload', (e: ReturnType<typeof aWebhook>) => e.withRawBody('[]')],
    ['event_id missing', 400, 'malformed_payload', (e: ReturnType<typeof aWebhook>) => e.without('event_id')],
    ['amount as a string', 400, 'malformed_payload', (e: ReturnType<typeof aWebhook>) => e.with('amount', '4900')],
    ['a negative amount', 400, 'malformed_payload', (e: ReturnType<typeof aWebhook>) => e.with('amount', -1900)],
    ['an unsupported event type', 422, 'unsupported_event_type', (e: ReturnType<typeof aWebhook>) => e.withType('customer.deleted')],
    ['an unknown invoice id', 422, 'unknown_reference', (e: ReturnType<typeof aWebhook>) => e.with('invoice_id', 'inv_9999')],
    ['an invoice from another subscription', 422, 'unknown_reference', (e: ReturnType<typeof aWebhook>) => e.with('subscription_id', 'sub_9999')],
    ['an amount different from the invoice', 422, 'amount_mismatch', (e: ReturnType<typeof aWebhook>) => e.with('amount', 100)],
    ['a currency different from the invoice', 422, 'amount_mismatch', (e: ReturnType<typeof aWebhook>) => e.with('currency', 'EUR')],
  ])('rejects %s with %i %s and persists nothing', async (_label, status, code, variant) => {
    const { webhooks, verify, notifier } = t.env;
    const { g, before } = await pendingTarget();
    const notificationsBefore = notifier.sent.length;
    const event = variant(aWebhook().paymentSucceeded().forInvoice(g.invoice!));

    const res = await webhooks.deliver(event);

    expect(res.status).toBe(status);
    expect(res.error?.code).toBe(code);
    verify.expectUnchangedSince(before);
    verify.expectNoWebhookEvent(event.eventId);
    expect(notifier.sent).toHaveLength(notificationsBefore);
  });

  it('a rejected (forged) delivery does not burn the event_id: the genuine event is still applied', async () => {
    const { webhooks, verify } = t.env;
    const { g } = await pendingTarget();
    const forged = aWebhook().paymentFailed().forInvoice(g.invoice!).withEventId('evt_shared').withForgedSignature();
    const genuine = aWebhook().paymentSucceeded().forInvoice(g.invoice!).withEventId('evt_shared');

    expect((await webhooks.deliver(forged)).status).toBe(401);
    const res = await webhooks.deliver(genuine);

    expect(res.body.outcome).toBe('applied');
    await verify.expectStatus(g.subscription.id, 'active');
  });
});
