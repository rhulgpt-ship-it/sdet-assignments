import type { Transition } from '../../../src/domain/SubscriptionStateMachine';
import { TRANSITIONS } from '../../../src/domain/SubscriptionStateMachine';
import type { AuditSource } from '../../../src/domain/types';
import { aWebhook } from '../../support/builders/WebhookEventBuilder';
import type { GivenSubscription } from '../../support/fixtures/ScenarioSteps';
import type { TestEnvironment } from '../../support/fixtures/TestEnvironment';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Every row of the transition table, driven through the real entry points.
 * Where a transition can be caused both synchronously (billing run / API) and asynchronously
 * (provider webhook), both drivers are exercised.
 *
 * Common assertions per scenario (API + DB + audit + side effects):
 *   - GET, the subscriptions row and the last audit entry all show the target status
 *   - the last audit entry records exactly this transition, trigger and driver
 *   - the matching notification fired once
 * The afterEach invariant check then verifies invoices, provider calls and the whole audit path.
 */

interface Scenario {
  name: string;
  driver: AuditSource;
  run(env: TestEnvironment): Promise<GivenSubscription>;
}

async function retryUntilLastAttempt(env: TestEnvironment, given: GivenSubscription): Promise<GivenSubscription> {
  // pastDue() already used attempt 1; decline retries until only the final attempt remains.
  let current = given;
  for (let attempt = 2; attempt <= env.billingRules.maxRetries; attempt += 1) {
    env.provider.willDecline();
    env.clock.advanceTo(current.subscription.next_retry_at!);
    await env.api.runBilling();
    current = await env.given.refresh(current);
  }
  return current;
}

const scenarios: Record<string, Scenario[]> = {
  'trialing->active': [
    {
      name: 'trial ends and the first charge succeeds',
      driver: 'billing',
      run: async (env) => {
        const given = await env.given.trialing();
        env.provider.willSucceed();
        await env.given.endTrialAndBill(given.subscription);
        return given;
      },
    },
    {
      name: 'trial-end charge timed out, provider later confirms payment.succeeded',
      driver: 'webhook',
      run: async (env) => {
        const given = await env.given.trialingWithUnknownCharge();
        await env.webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(given.invoice!));
        return given;
      },
    },
  ],
  'trialing->past_due': [
    {
      name: 'trial ends and the first charge is declined',
      driver: 'billing',
      run: async (env) => {
        const given = await env.given.trialing();
        env.provider.willDecline();
        await env.given.endTrialAndBill(given.subscription);
        return given;
      },
    },
    {
      name: 'trial-end charge timed out, provider later reports payment.failed',
      driver: 'webhook',
      run: async (env) => {
        const given = await env.given.trialingWithUnknownCharge();
        await env.webhooks.deliver(aWebhook().paymentFailed().forInvoice(given.invoice!));
        return given;
      },
    },
  ],
  'active->past_due': [
    {
      name: 'recurring renewal charge is declined',
      driver: 'billing',
      run: async (env) => {
        const given = await env.given.active();
        env.provider.willDecline();
        env.clock.advanceTo(given.subscription.current_period_end!);
        await env.api.runBilling();
        return given;
      },
    },
    {
      name: 'renewal charge timed out, provider later reports payment.failed',
      driver: 'webhook',
      run: async (env) => {
        const given = await env.given.activeWithUnknownRenewal();
        await env.webhooks.deliver(aWebhook().paymentFailed().forInvoice(given.invoice!));
        return given;
      },
    },
  ],
  'past_due->active': [
    {
      name: 'scheduled retry charge succeeds',
      driver: 'billing',
      run: async (env) => {
        const given = await env.given.pastDue();
        env.provider.willSucceed();
        env.clock.advanceTo(given.subscription.next_retry_at!);
        await env.api.runBilling();
        return given;
      },
    },
    {
      name: 'retry charge timed out, provider later confirms payment.succeeded',
      driver: 'webhook',
      run: async (env) => {
        const given = await env.given.pastDueWithUnknownRetry();
        await env.webhooks.deliver(aWebhook().paymentSucceeded().forInvoice(given.invoice!));
        return given;
      },
    },
  ],
  'past_due->canceled': [
    {
      name: 'final retry is declined (retries exhausted)',
      driver: 'billing',
      run: async (env) => {
        const given = await retryUntilLastAttempt(env, await env.given.pastDue());
        env.provider.willDecline();
        env.clock.advanceTo(given.subscription.next_retry_at!);
        await env.api.runBilling();
        return given;
      },
    },
    {
      name: 'final retry timed out, provider later reports payment.failed',
      driver: 'webhook',
      run: async (env) => {
        const given = await retryUntilLastAttempt(env, await env.given.pastDue());
        env.provider.willTimeout();
        env.clock.advanceTo(given.subscription.next_retry_at!);
        await env.api.runBilling();
        const lastAttempt = env.repos.invoices.latestForSubscription(given.subscription.id)!;
        await env.webhooks.deliver(aWebhook().paymentFailed().forInvoice(lastAttempt));
        return given;
      },
    },
  ],
  'active->canceled': [
    {
      name: 'customer cancels an active subscription',
      driver: 'api',
      run: async (env) => {
        const given = await env.given.active();
        await env.api.cancelSubscription(given.subscription.id);
        return given;
      },
    },
  ],
  'trialing->canceled': [
    {
      name: 'customer cancels during the trial',
      driver: 'api',
      run: async (env) => {
        const given = await env.given.trialing();
        await env.api.cancelSubscription(given.subscription.id);
        return given;
      },
    },
  ],
};

const key = (t: Transition) => `${t.from}->${t.to}`;
const NOTIFICATION = { active: 'subscription.activated', past_due: 'subscription.past_due', canceled: 'subscription.canceled' };

describe('Lifecycle: every valid transition', () => {
  const t = useTestEnvironment();

  it('has at least one scenario for every row of the transition table (and none for anything else)', () => {
    expect(Object.keys(scenarios).sort()).toEqual(TRANSITIONS.map(key).sort());
    Object.values(scenarios).forEach((list) => expect(list.length).toBeGreaterThan(0));
  });

  describe.each(TRANSITIONS.map((tr) => [key(tr), tr] as const))('%s', (_label, transition) => {
    it.each(scenarios[key(transition)].map((s) => [s.driver, s.name, s] as const))(
      'via %s: %s',
      async (_driver, _name, scenario) => {
        const env = t.env;
        const given = await scenario.run(env);
        const id = given.subscription.id;

        await env.verify.expectStatus(id, transition.to);

        const audit = env.repos.audit.findBySubscription(id);
        expect(audit[audit.length - 1]).toMatchObject({
          kind: 'transition',
          from_status: transition.from,
          to_status: transition.to,
          trigger: transition.trigger,
          source: scenario.driver,
        });

        const sent = env.notifier.for(id);
        expect(sent[sent.length - 1]).toBe(NOTIFICATION[transition.to as keyof typeof NOTIFICATION]);
      },
    );
  });
});
