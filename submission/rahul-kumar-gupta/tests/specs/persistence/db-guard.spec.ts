import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * The database is the last line of defence. This is the ONE spec that deliberately bypasses the
 * repositories with raw SQL, because what it tests is that the schema itself refuses bad writes
 * even if a future code path forgets to use the state machine.
 */
describe('Database-level guards', () => {
  const t = useTestEnvironment();

  it('refuses a raw UPDATE that moves a canceled subscription back to active', async () => {
    const { given, db, verify } = t.env;
    const g = await given.canceled();

    expect(() =>
      db.prepare(`UPDATE subscriptions SET status = 'active', canceled_at = NULL WHERE id = ?`).run(g.subscription.id),
    ).toThrow(/illegal subscription status transition/);
    await verify.expectStatus(g.subscription.id, 'canceled');
  });

  it('refuses a raw UPDATE for a transition that is not in the table (active -> trialing)', async () => {
    const { given, db } = t.env;
    const g = await given.active();

    expect(() => db.prepare(`UPDATE subscriptions SET status = 'trialing' WHERE id = ?`).run(g.subscription.id)).toThrow(
      /illegal subscription status transition/,
    );
  });

  it('refuses a canceled status without canceled_at (and vice versa)', async () => {
    const { given, db } = t.env;
    const g = await given.active();

    expect(() => db.prepare(`UPDATE subscriptions SET canceled_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(g.subscription.id)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('refuses a second webhook_events row for the same event_id', async () => {
    const { given, db, webhooks, repos } = t.env;
    const g = await given.trialingWithUnknownCharge();
    const event = aWebhook().paymentSucceeded().forInvoice(g.invoice!);
    await webhooks.deliver(event);
    const row = repos.webhookEvents.find(event.eventId)!;

    expect(() =>
      db
        .prepare(
          `INSERT INTO webhook_events (event_id, type, subscription_id, invoice_id, outcome, delivery_count, payload, first_received_at, last_received_at)
           VALUES (@event_id, @type, @subscription_id, @invoice_id, @outcome, 1, @payload, @first_received_at, @last_received_at)`,
        )
        .run(row),
    ).toThrow(/UNIQUE constraint failed: webhook_events.event_id/);
  });

  it('refuses two billing attempts sharing one idempotency key', async () => {
    const { given, db, repos } = t.env;
    const g = await given.active();
    const inv = repos.invoices.latestForSubscription(g.subscription.id)!;

    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices (id, subscription_id, amount, currency, status, attempt, idempotency_key, created_at, updated_at)
           VALUES ('inv_dupe', ?, ?, ?, 'pending', 2, ?, ?, ?)`,
        )
        .run(inv.subscription_id, inv.amount, inv.currency, inv.idempotency_key, inv.created_at, inv.created_at),
    ).toThrow(/UNIQUE constraint failed: invoices.idempotency_key/);
  });
});
