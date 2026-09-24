import type { Invoice } from '../../../src/domain/types';
import type { SubscriptionView } from '../../../src/services/SubscriptionService';
import type { CustomerSeed } from '../builders/CustomerBuilder';
import { aSubscriptionRequest } from '../builders/SubscriptionRequestBuilder';
import type { TestEnvironment } from './TestEnvironment';

export interface GivenSubscription {
  customer: CustomerSeed;
  subscription: SubscriptionView;
  /** Latest billing attempt, if any. */
  invoice: Invoice | undefined;
}

/**
 * "Given" steps that reach a lifecycle state the way production would — through the public API,
 * the billing run and signed webhooks — never by inserting rows. So every precondition is itself
 * a legal path through the state machine, and the invariant checker still holds afterwards.
 */
export class ScenarioSteps {
  constructor(private readonly env: TestEnvironment) {}

  async trialing(): Promise<GivenSubscription> {
    const customer = this.env.seedCustomer();
    const res = await this.env.api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('basic').build());
    if (res.status !== 201 || res.body.status !== 'trialing') throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
    return this.snapshot(customer, res.body.id);
  }

  /** Basic plan, trial ended, first charge succeeded (driven by the billing run). */
  async active(): Promise<GivenSubscription> {
    const given = await this.trialing();
    this.env.provider.willSucceed();
    await this.endTrialAndBill(given.subscription);
    return this.expectState(given, 'active');
  }

  /** Pro plan, charged at creation. */
  async activePro(): Promise<GivenSubscription> {
    const customer = this.env.seedCustomer();
    this.env.provider.willSucceed();
    const res = await this.env.api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('pro').build());
    return this.expectState(await this.snapshot(customer, res.body.id), 'active');
  }

  /** Basic plan, trial ended, first charge declined. */
  async pastDue(): Promise<GivenSubscription> {
    const given = await this.trialing();
    this.env.provider.willDecline('insufficient_funds');
    await this.endTrialAndBill(given.subscription);
    return this.expectState(given, 'past_due');
  }

  /** Trial ended and the first charge timed out: invoice pending, status still trialing. */
  async trialingWithUnknownCharge(): Promise<GivenSubscription> {
    const given = await this.trialing();
    this.env.provider.willTimeout();
    await this.endTrialAndBill(given.subscription);
    const result = await this.expectState(given, 'trialing');
    if (result.invoice?.status !== 'pending') throw new Error('setup failed: expected a pending invoice');
    return result;
  }

  /** Active, then the renewal charge timed out: renewal invoice pending, still active. */
  async activeWithUnknownRenewal(): Promise<GivenSubscription> {
    const given = await this.active();
    this.env.provider.willTimeout();
    this.env.clock.advanceTo(given.subscription.current_period_end!);
    await this.env.api.runBilling();
    const result = await this.expectState(given, 'active');
    if (result.invoice?.status !== 'pending') throw new Error('setup failed: expected a pending renewal');
    return result;
  }

  /** Past due, then the retry charge timed out. */
  async pastDueWithUnknownRetry(): Promise<GivenSubscription> {
    const given = await this.pastDue();
    this.env.provider.willTimeout();
    this.env.clock.advanceTo(given.subscription.next_retry_at!);
    await this.env.api.runBilling();
    const result = await this.expectState(given, 'past_due');
    if (result.invoice?.status !== 'pending') throw new Error('setup failed: expected a pending retry');
    return result;
  }

  async canceled(): Promise<GivenSubscription> {
    const given = await this.active();
    await this.env.api.cancelSubscription(given.subscription.id);
    return this.expectState(given, 'canceled');
  }

  // ---- step helpers usable from specs ------------------------------------------------------

  async endTrialAndBill(sub: SubscriptionView): Promise<void> {
    this.env.clock.advanceTo(sub.trial_ends_at!);
    await this.env.api.runBilling();
  }

  async refresh(given: GivenSubscription): Promise<GivenSubscription> {
    return this.snapshot(given.customer, given.subscription.id);
  }

  private async expectState(given: GivenSubscription, status: SubscriptionView['status']): Promise<GivenSubscription> {
    const fresh = await this.refresh(given);
    if (fresh.subscription.status !== status) {
      throw new Error(`setup failed: expected '${status}', got '${fresh.subscription.status}'`);
    }
    return fresh;
  }

  private async snapshot(customer: CustomerSeed, id: string): Promise<GivenSubscription> {
    const res = await this.env.api.getSubscription(id);
    return { customer, subscription: res.body, invoice: this.env.repos.invoices.latestForSubscription(id) };
  }
}
