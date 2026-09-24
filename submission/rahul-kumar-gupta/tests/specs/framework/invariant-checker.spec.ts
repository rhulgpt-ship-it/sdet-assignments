import { TestEnvironment } from '../../support/fixtures/TestEnvironment';

/**
 * Tests for the test framework: an invariant checker that never fails is worthless.
 * Each case builds a legal state through the API, then corrupts persistence directly (bypassing
 * the service on purpose) and proves the checker reports it. Uses TestEnvironment.create()
 * rather than useTestEnvironment() because the corrupted state must NOT fail afterEach.
 */
describe('InvariantChecker catches inconsistent state', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });
  afterEach(() => env.close());

  it('passes on a clean, legal state', async () => {
    await env.given.active();
    await expect(env.invariants.checkAll()).resolves.toBeUndefined();
  });

  it('flags an active subscription whose only invoice is failed', async () => {
    const g = await env.given.active();
    env.db.prepare(`UPDATE invoices SET status = 'failed', paid_at = NULL, failure_code = 'x' WHERE id = ?`).run(g.invoice!.id);
    await expect(env.invariants.checkAll()).rejects.toThrow(/is active with no paid invoice/);
  });

  it('flags an invoice billed at a price that differs from the plan', async () => {
    const g = await env.given.active();
    env.db.prepare('UPDATE invoices SET amount = 999 WHERE id = ?').run(g.invoice!.id);
    await expect(env.invariants.checkAll()).rejects.toThrow(/billed 999 USD, plan 'basic' is 1900 USD/);
  });

  it('flags a notification that fired twice for one transition', async () => {
    const g = await env.given.active();
    env.notifier.notify({ subscriptionId: g.subscription.id, type: 'subscription.activated' });
    await expect(env.invariants.checkAll()).rejects.toThrow(/notifications .* do not match transitions/);
  });

  it('flags a provider call that no billing attempt accounts for', async () => {
    const g = await env.given.active();
    await env.provider.charge({ ...env.provider.calls[0] }); // a second, unjustified charge for the same attempt
    await expect(env.invariants.checkAll()).rejects.toThrow(new RegExp(`${g.invoice!.id} sent 2 times`));
  });

  it('flags an audit trail that no longer matches the subscription row', async () => {
    const g = await env.given.active();
    env.db.prepare('DELETE FROM subscription_audit WHERE subscription_id = ? AND kind = ?').run(g.subscription.id, 'transition');
    await expect(env.invariants.checkAll()).rejects.toThrow(/audit ends at 'trialing' but row is 'active'/);
  });

  it('flags a canceled subscription that still has a pending billing attempt', async () => {
    const g = await env.given.trialingWithUnknownCharge();
    await env.api.cancelSubscription(g.subscription.id);
    env.db.prepare(`UPDATE invoices SET status = 'pending' WHERE id = ?`).run(g.invoice!.id);
    await expect(env.invariants.checkAll()).rejects.toThrow(/canceled but still has pending invoice/);
  });
});
