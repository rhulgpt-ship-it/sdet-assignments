import { createHash } from 'node:crypto';
import type { PlanRegistry } from '../domain/plans/PlanPolicy';
import { Errors } from '../domain/errors';
import { SubscriptionStateMachine } from '../domain/SubscriptionStateMachine';
import type { Subscription } from '../domain/types';
import type { Repositories } from '../persistence/repositories';
import type { Clock, IdGenerator, Notifier } from '../ports';
import type { BillingService } from './BillingService';

export interface CreateSubscriptionInput {
  customer_id: string;
  plan: string;
  payment_method_id: string;
}

export interface SubscriptionView {
  id: string;
  customer_id: string;
  plan: string;
  status: Subscription['status'];
  payment_method_id: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_retry_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
  latest_invoice: { id: string; amount: number; currency: string; status: string; attempt: number } | null;
}

export class SubscriptionService {
  constructor(
    private readonly repos: Repositories,
    private readonly plans: PlanRegistry,
    private readonly billing: BillingService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Validates, persists the subscription in `trialing`, and — for plans without a trial —
   * performs the first charge inside the request. A zero-day trial still goes through
   * trialing -> active / past_due, so there is no shortcut outside the transition table.
   */
  async create(body: unknown): Promise<SubscriptionView> {
    const input = this.validate(body);
    const plan = this.plans.find(input.plan);
    if (!plan) throw Errors.unknownPlan(input.plan);
    if (!this.repos.customers.find(input.customer_id)) throw Errors.customerNotFound(input.customer_id);
    const pm = this.repos.customers.findPaymentMethod(input.payment_method_id);
    if (!pm || pm.customer_id !== input.customer_id || pm.status !== 'valid') {
      throw Errors.invalidPaymentMethod(input.payment_method_id);
    }

    const now = this.clock.now();
    const at = now.toISOString();
    const sub: Subscription = {
      id: this.ids.next('sub'),
      customer_id: input.customer_id,
      plan: plan.code,
      payment_method_id: pm.id,
      status: 'trialing',
      trial_ends_at: plan.trialEndsAt(now).toISOString(),
      current_period_start: null,
      current_period_end: null,
      next_retry_at: null,
      canceled_at: null,
      created_at: at,
      updated_at: at,
    };
    this.repos.inTransaction(() => this.repos.subscriptions.insert(sub, { source: 'api', sourceRef: null, at }));

    if (plan.chargesImmediately()) {
      await this.billing.chargeNewAttempt(sub, 1, 'api');
    }
    return this.get(sub.id);
  }

  /**
   * Create with client-supplied Idempotency-Key: a retried request returns the original
   * response and never creates a second subscription or a second charge.
   */
  async createIdempotent(body: unknown, key: string): Promise<{ status: number; body: unknown; replayed: boolean }> {
    const hash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
    const existing = this.repos.idempotency.find(key);
    if (existing) {
      if (existing.request_hash !== hash) throw Errors.idempotencyKeyReused();
      if (existing.state === 'in_progress') throw Errors.requestInProgress();
      return { status: existing.response_code!, body: JSON.parse(existing.response_body!), replayed: true };
    }
    this.repos.idempotency.begin(key, hash, this.clock.now().toISOString());
    try {
      const view = await this.create(body);
      this.repos.idempotency.complete(key, 201, view);
      return { status: 201, body: view, replayed: false };
    } catch (err) {
      // Nothing was created, so the client may retry with the same key after fixing the request.
      this.repos.idempotency.release(key);
      throw err;
    }
  }

  get(id: string): SubscriptionView {
    const sub = this.repos.subscriptions.find(id);
    if (!sub) throw Errors.subscriptionNotFound(id);
    return this.toView(sub);
  }

  cancel(id: string): SubscriptionView {
    const at = this.clock.now().toISOString();
    this.repos.inTransaction(() => {
      const sub = this.repos.subscriptions.find(id);
      if (!sub) throw Errors.subscriptionNotFound(id);
      if (sub.status === 'canceled') throw Errors.alreadyCanceled(id);
      if (!SubscriptionStateMachine.can(sub.status, 'cancel_requested')) {
        throw Errors.illegalTransition(id, sub.status, 'cancel');
      }
      // Stop future billing: an in-flight attempt can no longer settle this subscription.
      this.repos.invoices.voidPending(id, at);
      this.repos.subscriptions.transition(id, 'cancel_requested', { source: 'api', sourceRef: null, at });
    });
    this.notifier.notify({ subscriptionId: id, type: 'subscription.canceled' });
    return this.get(id);
  }

  private toView(sub: Subscription): SubscriptionView {
    const latest = this.repos.invoices.latestForSubscription(sub.id);
    return {
      id: sub.id,
      customer_id: sub.customer_id,
      plan: sub.plan,
      status: sub.status,
      payment_method_id: sub.payment_method_id,
      trial_ends_at: sub.trial_ends_at,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      next_retry_at: sub.next_retry_at,
      canceled_at: sub.canceled_at,
      created_at: sub.created_at,
      updated_at: sub.updated_at,
      latest_invoice: latest
        ? { id: latest.id, amount: latest.amount, currency: latest.currency, status: latest.status, attempt: latest.attempt }
        : null,
    };
  }

  private validate(body: unknown): CreateSubscriptionInput {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw Errors.validation(['body must be a JSON object']);
    }
    const b = body as Record<string, unknown>;
    const problems: string[] = [];
    for (const field of ['customer_id', 'plan', 'payment_method_id'] as const) {
      if (b[field] === undefined || b[field] === null) problems.push(`${field} is required`);
      else if (typeof b[field] !== 'string' || (b[field] as string).trim() === '') {
        problems.push(`${field} must be a non-empty string`);
      }
    }
    if (problems.length) throw Errors.validation(problems);
    return { customer_id: b.customer_id as string, plan: b.plan as string, payment_method_id: b.payment_method_id as string };
  }
}
