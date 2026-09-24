import type { PlanRegistry } from '../../../src/domain/plans/PlanPolicy';
import { SubscriptionStateMachine } from '../../../src/domain/SubscriptionStateMachine';
import type { Subscription } from '../../../src/domain/types';
import type { Repositories } from '../../../src/persistence/repositories';
import type { SubscriptionApiClient } from '../clients/SubscriptionApiClient';
import type { MockPaymentProvider } from '../doubles/MockPaymentProvider';
import type { RecordingNotifier } from '../doubles/RecordingNotifier';

const TRANSITION_NOTIFICATION = {
  active: 'subscription.activated',
  past_due: 'subscription.past_due',
  canceled: 'subscription.canceled',
} as const;

/**
 * Business invariants that must hold after EVERY test, whatever the test was about.
 * Registered in afterEach by useTestEnvironment(), so a regression anywhere in the lifecycle
 * trips it even if no spec was written for that exact combination.
 *
 * Collects every violation (rather than stopping at the first) so the failure message
 * describes the whole inconsistency.
 */
export class InvariantChecker {
  private violations: string[] = [];

  constructor(
    private readonly repos: Repositories,
    private readonly api: SubscriptionApiClient,
    private readonly provider: MockPaymentProvider,
    private readonly notifier: RecordingNotifier,
    private readonly plans: PlanRegistry,
  ) {}

  async checkAll(): Promise<void> {
    this.violations = [];
    for (const sub of this.repos.subscriptions.findAll()) {
      this.activeHasPaidInvoice(sub);
      this.canceledIsTerminal(sub);
      this.auditIsLegalPath(sub);
      this.invoicesMatchPlan(sub);
      this.noContradictoryInvoices(sub);
      this.sideEffectsMatchTransitions(sub);
      await this.apiMatchesDatabase(sub);
    }
    this.providerCallsMatchBillingAttempts();
    this.webhookEventsCausedAtMostOneChange();

    if (this.violations.length) {
      throw new Error(`Invariant violations:\n  - ${this.violations.join('\n  - ')}`);
    }
  }

  private fail(message: string): void {
    this.violations.push(message);
  }

  /** I1: never `active` without at least one successful, persisted payment. */
  private activeHasPaidInvoice(sub: Subscription): void {
    if (sub.status !== 'active') return;
    const paid = this.repos.invoices.findBySubscription(sub.id).filter((i) => i.paid_at !== null);
    if (paid.length === 0) this.fail(`${sub.id} is active with no paid invoice`);
  }

  /** I2: `canceled` is terminal and nothing billing-related happens after it. */
  private canceledIsTerminal(sub: Subscription): void {
    const audit = this.repos.audit.findBySubscription(sub.id);
    const idx = audit.findIndex((a) => a.to_status === 'canceled');
    if (idx === -1) return;
    const after = audit.slice(idx + 1).filter((a) => a.kind !== 'invoice_refunded');
    if (after.length) this.fail(`${sub.id} changed after cancel: ${after.map((a) => a.kind).join(', ')}`);
    if (sub.status !== 'canceled') this.fail(`${sub.id} left 'canceled' (now '${sub.status}')`);
    if (!sub.canceled_at) this.fail(`${sub.id} canceled without canceled_at`);
    const pending = this.repos.invoices.findPendingBySubscription(sub.id);
    if (pending.length) this.fail(`${sub.id} is canceled but still has pending invoice(s)`);
  }

  /** I7: audit log is a legal walk through the transition table ending at the current status. */
  private auditIsLegalPath(sub: Subscription): void {
    const audit = this.repos.audit.findBySubscription(sub.id);
    if (audit[0]?.kind !== 'created' || audit[0].to_status !== 'trialing') {
      this.fail(`${sub.id} audit does not start with created -> trialing`);
    }
    let status = audit[0]?.to_status;
    for (const entry of audit.slice(1)) {
      if (entry.from_status !== status) this.fail(`${sub.id} audit gap: expected from '${status}', got '${entry.from_status}'`);
      if (entry.kind === 'transition') {
        const legal = SubscriptionStateMachine.legalStatusPairs().some(([f, t]) => f === entry.from_status && t === entry.to_status);
        if (!legal) this.fail(`${sub.id} audit has illegal transition ${entry.from_status} -> ${entry.to_status}`);
      } else if (entry.from_status !== entry.to_status) {
        this.fail(`${sub.id} non-transition audit entry '${entry.kind}' changed status`);
      }
      status = entry.to_status;
    }
    if (status !== sub.status) this.fail(`${sub.id} audit ends at '${status}' but row is '${sub.status}'`);
  }

  /** I6: plan price and currency are applied consistently to every billing attempt. */
  private invoicesMatchPlan(sub: Subscription): void {
    const plan = this.plans.get(sub.plan);
    for (const inv of this.repos.invoices.findBySubscription(sub.id)) {
      if (inv.amount !== plan.priceMinor || inv.currency !== plan.currency) {
        this.fail(`${inv.id} billed ${inv.amount} ${inv.currency}, plan '${plan.code}' is ${plan.priceMinor} ${plan.currency}`);
      }
    }
  }

  /** No record contradicts another: status-specific fields, timestamps, one attempt in flight. */
  private noContradictoryInvoices(sub: Subscription): void {
    const invoices = this.repos.invoices.findBySubscription(sub.id);
    if (invoices.filter((i) => i.status === 'pending').length > 1) this.fail(`${sub.id} has more than one pending attempt`);
    for (const inv of invoices) {
      const settled = inv.status === 'paid' || inv.status === 'refunded';
      if (settled && (!inv.paid_at || !inv.provider_charge_id)) this.fail(`${inv.id} is ${inv.status} without paid_at/charge id`);
      if (!settled && inv.paid_at) this.fail(`${inv.id} is ${inv.status} but has paid_at`);
      if (inv.status === 'failed' && !inv.failure_code) this.fail(`${inv.id} failed without failure_code`);
      if (inv.paid_at && inv.paid_at < inv.created_at) this.fail(`${inv.id} paid before it was created`);
      if (inv.created_at < sub.created_at) this.fail(`${inv.id} created before its subscription`);
    }
    if (sub.updated_at < sub.created_at) this.fail(`${sub.id} updated_at precedes created_at`);
    if (sub.canceled_at && sub.canceled_at < sub.created_at) this.fail(`${sub.id} canceled before created`);
    if (sub.status === 'past_due' && !sub.next_retry_at) this.fail(`${sub.id} is past_due with no retry scheduled`);
  }

  /** I3 (side effects): exactly one notification per real status transition, never more. */
  private sideEffectsMatchTransitions(sub: Subscription): void {
    const expected = this.repos.audit
      .findBySubscription(sub.id)
      .filter((a) => a.kind === 'transition')
      .map((a) => TRANSITION_NOTIFICATION[a.to_status as keyof typeof TRANSITION_NOTIFICATION]);
    const actual = this.notifier.for(sub.id);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      this.fail(`${sub.id} notifications [${actual}] do not match transitions [${expected}]`);
    }
  }

  /** I5: what the API reports is what is persisted. */
  private async apiMatchesDatabase(sub: Subscription): Promise<void> {
    const res = await this.api.getSubscription(sub.id);
    if (res.status !== 200 || res.body.status !== sub.status || res.body.updated_at !== sub.updated_at) {
      this.fail(`${sub.id} API reports '${res.body.status}' but DB has '${sub.status}'`);
    }
  }

  /**
   * I4: provider calls map 1:1 onto billing attempts.
   * - every call references a real invoice and carries exactly that invoice's amount/currency/key
   * - every invoice was sent to the provider
   * - a key is only re-sent after a timeout (unknown outcome), never otherwise
   */
  private providerCallsMatchBillingAttempts(): void {
    const invoices = new Map(this.repos.invoices.findAll().map((i) => [i.id, i]));
    for (const call of this.provider.calls) {
      const inv = invoices.get(call.reference);
      if (!inv) {
        this.fail(`provider charged unknown reference '${call.reference}'`);
        continue;
      }
      const sub = this.repos.subscriptions.find(inv.subscription_id)!;
      if (
        call.amount !== inv.amount ||
        call.currency !== inv.currency ||
        call.idempotencyKey !== inv.idempotency_key ||
        call.customerId !== sub.customer_id ||
        call.paymentMethodId !== sub.payment_method_id
      ) {
        this.fail(`provider call for ${inv.id} does not match the invoice/subscription`);
      }
    }
    for (const inv of invoices.values()) {
      const calls = this.provider.callsFor(inv.id).length;
      if (calls === 0) this.fail(`${inv.id} was never sent to the provider`);
      const allowed = 1 + this.provider.timeoutsFor(inv.idempotency_key);
      if (calls > allowed) this.fail(`${inv.id} sent ${calls} times but only ${allowed - 1} timeout(s) justify a re-send`);
    }
  }

  /** I3 (webhooks): one event id never causes more than one audit entry. */
  private webhookEventsCausedAtMostOneChange(): void {
    for (const ev of this.repos.webhookEvents.findAll()) {
      const entries = this.repos.audit.findBySubscription(ev.subscription_id).filter((a) => a.source === 'webhook' && a.source_ref === ev.event_id);
      if (entries.length > 1) this.fail(`webhook ${ev.event_id} produced ${entries.length} audit entries`);
      if (ev.outcome !== 'applied' && entries.length) this.fail(`webhook ${ev.event_id} was '${ev.outcome}' but changed state`);
    }
  }
}
