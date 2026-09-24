import type { PlanRegistry } from '../domain/plans/PlanPolicy';
import type { Invoice, Subscription, WebhookOutcome } from '../domain/types';
import type { Repositories, TransitionContext } from '../persistence/repositories';
import type { SubscriptionNotification } from '../ports';

export interface BillingRules {
  /** Retries allowed after the first failed attempt of a billing cycle. */
  maxRetries: number;
  retryIntervalMs: number;
}

export const DEFAULT_BILLING_RULES: BillingRules = {
  maxRetries: 3,
  retryIntervalMs: 24 * 60 * 60 * 1000,
};

export type OutcomeResult = {
  outcome: Exclude<WebhookOutcome, 'duplicate'>;
  notifications: SubscriptionNotification[];
};

/**
 * The single place where a charge outcome (from the synchronous provider response OR from an
 * asynchronous webhook) is applied to an invoice and a subscription.
 *
 * Because billing and webhooks share these rules, "late webhook confirms a charge we already
 * recorded" and "stray webhook after cancel" behave identically whichever path saw it first.
 *
 * Must be called inside a transaction; notifications are returned, not sent, so the caller can
 * fire them only after the transaction commits.
 */
export class PaymentOutcomeProcessor {
  constructor(
    private readonly repos: Repositories,
    private readonly plans: PlanRegistry,
    private readonly rules: BillingRules,
  ) {}

  applySuccess(invoice: Invoice, chargeId: string, ctx: TransitionContext): OutcomeResult {
    const sub = this.subscriptionOf(invoice);
    const guard = this.guard(sub, invoice);
    if (guard) return guard;

    this.repos.invoices.markPaid(invoice.id, chargeId, ctx.at);
    const plan = this.plans.get(sub.plan);

    if (sub.status === 'active') {
      // Recurring renewal: no status change, the period rolls forward from where it ended.
      const start = sub.current_period_end ?? ctx.at;
      this.repos.subscriptions.updateSchedule(
        sub.id,
        { current_period_start: start, current_period_end: plan.periodEndFrom(new Date(start)).toISOString() },
        ctx.at,
      );
      this.repos.audit.append({
        subscription_id: sub.id,
        kind: 'renewed',
        from_status: 'active',
        to_status: 'active',
        trigger: 'charge_succeeded',
        source: ctx.source,
        source_ref: ctx.sourceRef,
        created_at: ctx.at,
      });
      return { outcome: 'applied', notifications: [] };
    }

    // trialing -> active, past_due -> active
    this.repos.subscriptions.transition(sub.id, 'charge_succeeded', ctx);
    this.repos.subscriptions.updateSchedule(
      sub.id,
      { current_period_start: ctx.at, current_period_end: plan.periodEndFrom(new Date(ctx.at)).toISOString() },
      ctx.at,
    );
    return { outcome: 'applied', notifications: [{ subscriptionId: sub.id, type: 'subscription.activated' }] };
  }

  applyFailure(invoice: Invoice, failureCode: string, ctx: TransitionContext): OutcomeResult {
    const sub = this.subscriptionOf(invoice);
    const guard = this.guard(sub, invoice);
    if (guard) return guard;

    this.repos.invoices.markFailed(invoice.id, failureCode, ctx.at);
    const nextRetryAt = new Date(new Date(ctx.at).getTime() + this.rules.retryIntervalMs).toISOString();

    if (sub.status === 'past_due') {
      if (invoice.attempt >= 1 + this.rules.maxRetries) {
        this.repos.subscriptions.transition(sub.id, 'retries_exhausted', ctx);
        return { outcome: 'applied', notifications: [{ subscriptionId: sub.id, type: 'subscription.canceled' }] };
      }
      this.repos.subscriptions.updateSchedule(sub.id, { next_retry_at: nextRetryAt }, ctx.at);
      return { outcome: 'applied', notifications: [] };
    }

    // trialing -> past_due, active -> past_due
    this.repos.subscriptions.transition(sub.id, 'charge_failed', ctx);
    this.repos.subscriptions.updateSchedule(sub.id, { next_retry_at: nextRetryAt }, ctx.at);
    return { outcome: 'applied', notifications: [{ subscriptionId: sub.id, type: 'subscription.past_due' }] };
  }

  /**
   * Refunds settle an already-paid invoice. The lifecycle diagram defines no transition for a
   * refund, so status is left alone; the refund is still recorded in the audit log.
   */
  applyRefund(invoice: Invoice, ctx: TransitionContext): OutcomeResult {
    const sub = this.subscriptionOf(invoice);
    if (invoice.status !== 'paid') return { outcome: 'ignored_invoice_already_settled', notifications: [] };

    this.repos.invoices.markRefunded(invoice.id, ctx.at);
    this.repos.audit.append({
      subscription_id: sub.id,
      kind: 'invoice_refunded',
      from_status: sub.status,
      to_status: sub.status,
      trigger: 'payment_refunded',
      source: ctx.source,
      source_ref: ctx.sourceRef,
      created_at: ctx.at,
    });
    return { outcome: 'applied', notifications: [] };
  }

  /** Rules shared by success and failure: canceled is terminal, settled invoices never change. */
  private guard(sub: Subscription, invoice: Invoice): OutcomeResult | undefined {
    if (sub.status === 'canceled') return { outcome: 'ignored_subscription_canceled', notifications: [] };
    if (invoice.status !== 'pending') return { outcome: 'ignored_invoice_already_settled', notifications: [] };
    return undefined;
  }

  private subscriptionOf(invoice: Invoice): Subscription {
    const sub = this.repos.subscriptions.find(invoice.subscription_id);
    if (!sub) throw new Error(`Invoice '${invoice.id}' references missing subscription`);
    return sub;
  }
}
