import type { SubscriptionStatus } from '../../../src/domain/SubscriptionStateMachine';
import type { AuditEntry, Invoice, Subscription, WebhookEventRecord, WebhookOutcome } from '../../../src/domain/types';
import type { Repositories } from '../../../src/persistence/repositories';
import type { SubscriptionView } from '../../../src/services/SubscriptionService';
import type { SubscriptionApiClient } from '../clients/SubscriptionApiClient';

export interface PersistedState {
  subscription: Subscription | undefined;
  invoices: Invoice[];
  audit: AuditEntry[];
  webhookEvents: WebhookEventRecord[];
}

/**
 * Cross-layer assertions: what the API says vs. what is persisted vs. what the audit log recorded.
 * Reads persistence only through repositories. Never mutates state.
 */
export class SubscriptionVerifier {
  constructor(
    private readonly api: SubscriptionApiClient,
    private readonly repos: Repositories,
  ) {}

  /** API status, DB status and the latest audit entry all agree on `status`. */
  async expectStatus(subscriptionId: string, status: SubscriptionStatus): Promise<void> {
    const res = await this.api.getSubscription(subscriptionId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(status);
    expect(this.repos.subscriptions.find(subscriptionId)?.status).toBe(status);
    const audit = this.repos.audit.findBySubscription(subscriptionId);
    expect(audit[audit.length - 1]?.to_status).toBe(status);
    await this.expectApiMatchesDatabase(subscriptionId);
  }

  /** Every field returned by GET equals the persisted row (and the latest invoice row). */
  async expectApiMatchesDatabase(subscriptionId: string): Promise<void> {
    const res = await this.api.getSubscription(subscriptionId);
    const row = this.repos.subscriptions.find(subscriptionId);
    expect(row).toBeDefined();
    const { latest_invoice, ...fields } = res.body as SubscriptionView;
    expect(fields).toEqual({
      id: row!.id,
      customer_id: row!.customer_id,
      plan: row!.plan,
      status: row!.status,
      payment_method_id: row!.payment_method_id,
      trial_ends_at: row!.trial_ends_at,
      current_period_start: row!.current_period_start,
      current_period_end: row!.current_period_end,
      next_retry_at: row!.next_retry_at,
      canceled_at: row!.canceled_at,
      created_at: row!.created_at,
      updated_at: row!.updated_at,
    });
    const latest = this.repos.invoices.latestForSubscription(subscriptionId);
    expect(latest_invoice).toEqual(
      latest ? { id: latest.id, amount: latest.amount, currency: latest.currency, status: latest.status, attempt: latest.attempt } : null,
    );
  }

  /** Exact list of billing attempts, in order. Length is checked, so extra rows fail the test. */
  expectInvoices(subscriptionId: string, expected: Array<Partial<Invoice>>): Invoice[] {
    const invoices = this.repos.invoices.findBySubscription(subscriptionId);
    expect(invoices).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(invoices[i]).toMatchObject(e));
    return invoices;
  }

  /** Status path through the lifecycle, e.g. ['trialing', 'active', 'canceled']. */
  expectStatusHistory(subscriptionId: string, statuses: SubscriptionStatus[]): void {
    const path = this.repos.audit
      .findBySubscription(subscriptionId)
      .filter((a) => a.kind === 'created' || a.kind === 'transition')
      .map((a) => a.to_status);
    expect(path).toEqual(statuses);
  }

  expectWebhookEvent(eventId: string, expected: { outcome: WebhookOutcome; delivery_count?: number }): WebhookEventRecord {
    const record = this.repos.webhookEvents.find(eventId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({ delivery_count: 1, ...expected });
    return record!;
  }

  expectNoWebhookEvent(eventId: string): void {
    expect(this.repos.webhookEvents.find(eventId)).toBeUndefined();
  }

  expectNoSubscriptionsFor(customerId: string): void {
    expect(this.repos.subscriptions.findByCustomer(customerId)).toEqual([]);
  }

  /** Full persisted picture of one subscription, for "nothing changed" before/after comparisons. */
  snapshot(subscriptionId: string): PersistedState {
    return {
      subscription: this.repos.subscriptions.find(subscriptionId),
      invoices: this.repos.invoices.findBySubscription(subscriptionId),
      audit: this.repos.audit.findBySubscription(subscriptionId),
      webhookEvents: this.repos.webhookEvents.findBySubscription(subscriptionId),
    };
  }

  expectUnchangedSince(before: PersistedState): void {
    const id = before.subscription!.id;
    expect(this.snapshot(id)).toEqual(before);
  }
}
