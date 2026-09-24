import type { PlanRegistry } from '../domain/plans/PlanPolicy';
import type { Invoice, Subscription } from '../domain/types';
import type { Repositories } from '../persistence/repositories';
import type { Clock, IdGenerator, Notifier, PaymentProvider } from '../ports';
import { ProviderTimeoutError } from '../ports';
import type { OutcomeResult, PaymentOutcomeProcessor } from './PaymentOutcomeProcessor';
import type { AuditSource } from '../domain/types';

export type ChargeAttemptResult = 'succeeded' | 'declined' | 'unknown';

export interface BillingRunEntry {
  subscription_id: string;
  invoice_id: string;
  reason: 'trial_end' | 'renewal' | 'retry' | 'resolve_unknown';
  result: ChargeAttemptResult | 'ignored';
}

/**
 * Talks to the payment provider. Every charge goes through the injected PaymentProvider seam,
 * with a stable idempotency key per billing attempt (one invoice row == one attempt).
 */
export class BillingService {
  constructor(
    private readonly repos: Repositories,
    private readonly plans: PlanRegistry,
    private readonly provider: PaymentProvider,
    private readonly processor: PaymentOutcomeProcessor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly notifier: Notifier,
  ) {}

  /** Creates a new billing attempt (invoice row) and charges it. */
  async chargeNewAttempt(sub: Subscription, attempt: number, source: AuditSource): Promise<{ invoice: Invoice; result: ChargeAttemptResult }> {
    const plan = this.plans.get(sub.plan);
    const at = this.nowIso();
    const invoiceId = this.ids.next('inv');
    const invoice: Invoice = {
      id: invoiceId,
      subscription_id: sub.id,
      amount: plan.priceMinor,
      currency: plan.currency,
      status: 'pending',
      attempt,
      idempotency_key: `charge_${invoiceId}`,
      provider_charge_id: null,
      failure_code: null,
      created_at: at,
      paid_at: null,
      updated_at: at,
    };
    this.repos.invoices.insert(invoice);
    const result = await this.charge(invoice, sub, source);
    return { invoice, result };
  }

  /**
   * Scheduled billing run (exposed on POST /internal/billing/run for tests).
   * 1. Re-sends attempts whose outcome is unknown (timeouts) with the SAME idempotency key.
   * 2. Starts new attempts for trials that ended, periods that ended, and retries that are due.
   * A subscription that still has a pending attempt is never charged again.
   */
  async runDue(): Promise<BillingRunEntry[]> {
    const entries: BillingRunEntry[] = [];

    for (const invoice of this.repos.invoices.findAllPending()) {
      const sub = this.repos.subscriptions.find(invoice.subscription_id)!;
      const result = await this.charge(invoice, sub, 'billing');
      entries.push({ subscription_id: sub.id, invoice_id: invoice.id, reason: 'resolve_unknown', result });
    }

    const now = this.clock.now().getTime();
    const due = (iso: string | null) => iso !== null && new Date(iso).getTime() <= now;
    const hasPending = (sub: Subscription) => this.repos.invoices.findPendingBySubscription(sub.id).length > 0;

    for (const sub of this.repos.subscriptions.findByStatus('trialing')) {
      if (due(sub.trial_ends_at) && !hasPending(sub)) {
        const { invoice, result } = await this.chargeNewAttempt(sub, 1, 'billing');
        entries.push({ subscription_id: sub.id, invoice_id: invoice.id, reason: 'trial_end', result });
      }
    }
    for (const sub of this.repos.subscriptions.findByStatus('active')) {
      if (due(sub.current_period_end) && !hasPending(sub)) {
        const { invoice, result } = await this.chargeNewAttempt(sub, 1, 'billing');
        entries.push({ subscription_id: sub.id, invoice_id: invoice.id, reason: 'renewal', result });
      }
    }
    for (const sub of this.repos.subscriptions.findByStatus('past_due')) {
      if (due(sub.next_retry_at) && !hasPending(sub)) {
        const previous = this.repos.invoices.latestForSubscription(sub.id);
        const { invoice, result } = await this.chargeNewAttempt(sub, (previous?.attempt ?? 0) + 1, 'billing');
        entries.push({ subscription_id: sub.id, invoice_id: invoice.id, reason: 'retry', result });
      }
    }
    return entries;
  }

  private async charge(invoice: Invoice, sub: Subscription, source: AuditSource): Promise<ChargeAttemptResult> {
    let response;
    try {
      response = await this.provider.charge({
        customerId: sub.customer_id,
        paymentMethodId: sub.payment_method_id,
        amount: invoice.amount,
        currency: invoice.currency,
        idempotencyKey: invoice.idempotency_key,
        reference: invoice.id,
      });
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        // Outcome unknown: the customer may or may not have been charged. Leave the invoice
        // pending and the status unchanged; a webhook or a same-key re-send will settle it.
        return 'unknown';
      }
      throw err;
    }

    const ctx = { source, sourceRef: invoice.id, at: this.nowIso() };
    const result: OutcomeResult = this.repos.inTransaction(() => {
      // Re-read inside the transaction: a webhook or a cancel may have landed while we awaited.
      const fresh = this.repos.invoices.find(invoice.id)!;
      return response.status === 'succeeded'
        ? this.processor.applySuccess(fresh, response.chargeId, ctx)
        : this.processor.applyFailure(fresh, response.declineCode, ctx);
    });
    result.notifications.forEach((n) => this.notifier.notify(n));
    return response.status;
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}
