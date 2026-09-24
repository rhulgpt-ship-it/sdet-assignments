/**
 * Repository pattern: every SQL statement in the project lives in this file.
 * Services write through these classes; the test verification layer reads through them.
 * Specs never contain raw SQL, except the two that test the safety nets themselves
 * (persistence/db-guard.spec.ts and framework/invariant-checker.spec.ts).
 */
import type { Db } from './db';
import type {
  AuditEntry,
  AuditSource,
  Customer,
  Invoice,
  PaymentMethod,
  Subscription,
  WebhookEventRecord,
  WebhookOutcome,
} from '../domain/types';
import type { LifecycleTrigger, SubscriptionStatus } from '../domain/SubscriptionStateMachine';
import { SubscriptionStateMachine } from '../domain/SubscriptionStateMachine';

export class CustomerRepository {
  constructor(private readonly db: Db) {}

  insert(customer: Customer): void {
    this.db
      .prepare('INSERT INTO customers (id, email, created_at) VALUES (@id, @email, @created_at)')
      .run(customer);
  }

  insertPaymentMethod(pm: PaymentMethod): void {
    this.db
      .prepare('INSERT INTO payment_methods (id, customer_id, status) VALUES (@id, @customer_id, @status)')
      .run(pm);
  }

  find(id: string): Customer | undefined {
    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  }

  findPaymentMethod(id: string): PaymentMethod | undefined {
    return this.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id) as PaymentMethod | undefined;
  }
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  append(entry: Omit<AuditEntry, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO subscription_audit
           (subscription_id, kind, from_status, to_status, trigger, source, source_ref, created_at)
         VALUES (@subscription_id, @kind, @from_status, @to_status, @trigger, @source, @source_ref, @created_at)`,
      )
      .run(entry);
  }

  findBySubscription(subscriptionId: string): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM subscription_audit WHERE subscription_id = ? ORDER BY id')
      .all(subscriptionId) as AuditEntry[];
  }
}

export interface TransitionContext {
  source: AuditSource;
  sourceRef: string | null;
  at: string;
}

type ScheduleFields = Partial<
  Pick<Subscription, 'current_period_start' | 'current_period_end' | 'next_retry_at' | 'trial_ends_at'>
>;

export class SubscriptionRepository {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditRepository,
  ) {}

  insert(sub: Subscription, ctx: TransitionContext): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, customer_id, plan, payment_method_id, status, trial_ends_at, current_period_start,
            current_period_end, next_retry_at, canceled_at, created_at, updated_at)
         VALUES (@id, @customer_id, @plan, @payment_method_id, @status, @trial_ends_at, @current_period_start,
            @current_period_end, @next_retry_at, @canceled_at, @created_at, @updated_at)`,
      )
      .run(sub);
    this.audit.append({
      subscription_id: sub.id,
      kind: 'created',
      from_status: null,
      to_status: sub.status,
      trigger: 'created',
      source: ctx.source,
      source_ref: ctx.sourceRef,
      created_at: ctx.at,
    });
  }

  find(id: string): Subscription | undefined {
    return this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Subscription | undefined;
  }

  findAll(): Subscription[] {
    return this.db.prepare('SELECT * FROM subscriptions ORDER BY created_at, id').all() as Subscription[];
  }

  findByCustomer(customerId: string): Subscription[] {
    return this.db.prepare('SELECT * FROM subscriptions WHERE customer_id = ?').all(customerId) as Subscription[];
  }

  findByStatus(status: SubscriptionStatus): Subscription[] {
    return this.db.prepare('SELECT * FROM subscriptions WHERE status = ? ORDER BY id').all(status) as Subscription[];
  }

  /**
   * The ONLY way a subscription's status changes. Goes through the state machine
   * (throws IllegalTransitionError) and writes the audit entry in the same statement batch.
   * Callers are expected to run this inside a transaction.
   */
  transition(id: string, trigger: LifecycleTrigger, ctx: TransitionContext): { from: SubscriptionStatus; to: SubscriptionStatus } {
    const current = this.find(id);
    if (!current) throw new Error(`Subscription '${id}' not found`);
    const to = SubscriptionStateMachine.next(current.status, trigger);
    this.db
      .prepare(
        `UPDATE subscriptions
            SET status = @to,
                canceled_at = CASE WHEN @to = 'canceled' THEN @at ELSE canceled_at END,
                next_retry_at = CASE WHEN @to IN ('active', 'canceled') THEN NULL ELSE next_retry_at END,
                updated_at = @at
          WHERE id = @id`,
      )
      .run({ id, to, at: ctx.at });
    this.audit.append({
      subscription_id: id,
      kind: 'transition',
      from_status: current.status,
      to_status: to,
      trigger,
      source: ctx.source,
      source_ref: ctx.sourceRef,
      created_at: ctx.at,
    });
    return { from: current.status, to };
  }

  /** Billing-schedule fields only. Deliberately cannot touch `status`. */
  updateSchedule(id: string, fields: ScheduleFields, at: string): void {
    const current = this.find(id);
    if (!current) throw new Error(`Subscription '${id}' not found`);
    const next = { ...current, ...fields, updated_at: at };
    this.db
      .prepare(
        `UPDATE subscriptions
            SET trial_ends_at = @trial_ends_at, current_period_start = @current_period_start,
                current_period_end = @current_period_end, next_retry_at = @next_retry_at, updated_at = @updated_at
          WHERE id = @id`,
      )
      .run(next);
  }
}

export class InvoiceRepository {
  constructor(private readonly db: Db) {}

  insert(invoice: Invoice): void {
    this.db
      .prepare(
        `INSERT INTO invoices
           (id, subscription_id, amount, currency, status, attempt, idempotency_key, provider_charge_id,
            failure_code, created_at, paid_at, updated_at)
         VALUES (@id, @subscription_id, @amount, @currency, @status, @attempt, @idempotency_key, @provider_charge_id,
            @failure_code, @created_at, @paid_at, @updated_at)`,
      )
      .run(invoice);
  }

  find(id: string): Invoice | undefined {
    return this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Invoice | undefined;
  }

  findAll(): Invoice[] {
    return this.db.prepare('SELECT * FROM invoices ORDER BY created_at, id').all() as Invoice[];
  }

  findBySubscription(subscriptionId: string): Invoice[] {
    return this.db
      .prepare('SELECT * FROM invoices WHERE subscription_id = ? ORDER BY created_at, attempt, id')
      .all(subscriptionId) as Invoice[];
  }

  findPendingBySubscription(subscriptionId: string): Invoice[] {
    return this.db
      .prepare(`SELECT * FROM invoices WHERE subscription_id = ? AND status = 'pending' ORDER BY id`)
      .all(subscriptionId) as Invoice[];
  }

  findAllPending(): Invoice[] {
    return this.db.prepare(`SELECT * FROM invoices WHERE status = 'pending' ORDER BY id`).all() as Invoice[];
  }

  latestForSubscription(subscriptionId: string): Invoice | undefined {
    return this.db
      .prepare('SELECT * FROM invoices WHERE subscription_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(subscriptionId) as Invoice | undefined;
  }

  markPaid(id: string, chargeId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE invoices SET status = 'paid', provider_charge_id = ?, paid_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(chargeId, at, at, id);
  }

  markFailed(id: string, failureCode: string, at: string): void {
    this.db
      .prepare(
        `UPDATE invoices SET status = 'failed', failure_code = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(failureCode, at, id);
  }

  markRefunded(id: string, at: string): void {
    this.db
      .prepare(`UPDATE invoices SET status = 'refunded', updated_at = ? WHERE id = ? AND status = 'paid'`)
      .run(at, id);
  }

  voidPending(subscriptionId: string, at: string): number {
    return this.db
      .prepare(`UPDATE invoices SET status = 'void', updated_at = ? WHERE subscription_id = ? AND status = 'pending'`)
      .run(at, subscriptionId).changes;
  }
}

export class WebhookEventRepository {
  constructor(private readonly db: Db) {}

  find(eventId: string): WebhookEventRecord | undefined {
    return this.db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(eventId) as
      | WebhookEventRecord
      | undefined;
  }

  findAll(): WebhookEventRecord[] {
    return this.db.prepare('SELECT * FROM webhook_events ORDER BY first_received_at, event_id').all() as WebhookEventRecord[];
  }

  findBySubscription(subscriptionId: string): WebhookEventRecord[] {
    return this.db
      .prepare('SELECT * FROM webhook_events WHERE subscription_id = ? ORDER BY first_received_at, event_id')
      .all(subscriptionId) as WebhookEventRecord[];
  }

  insert(record: Omit<WebhookEventRecord, 'delivery_count' | 'last_received_at'>): void {
    this.db
      .prepare(
        `INSERT INTO webhook_events
           (event_id, type, subscription_id, invoice_id, outcome, delivery_count, payload, first_received_at, last_received_at)
         VALUES (@event_id, @type, @subscription_id, @invoice_id, @outcome, 1, @payload, @first_received_at, @first_received_at)`,
      )
      .run(record);
  }

  recordRedelivery(eventId: string, at: string): void {
    this.db
      .prepare('UPDATE webhook_events SET delivery_count = delivery_count + 1, last_received_at = ? WHERE event_id = ?')
      .run(at, eventId);
  }

  countByOutcome(outcome: WebhookOutcome): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE outcome = ?').get(outcome) as { n: number }).n;
  }
}

export interface IdempotencyRecord {
  key: string;
  request_hash: string;
  state: 'in_progress' | 'completed';
  response_code: number | null;
  response_body: string | null;
  created_at: string;
}

export class IdempotencyRepository {
  constructor(private readonly db: Db) {}

  find(key: string): IdempotencyRecord | undefined {
    return this.db.prepare('SELECT * FROM idempotency_requests WHERE key = ?').get(key) as IdempotencyRecord | undefined;
  }

  begin(key: string, requestHash: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_requests (key, request_hash, state, created_at) VALUES (?, ?, 'in_progress', ?)`,
      )
      .run(key, requestHash, at);
  }

  complete(key: string, code: number, body: unknown): void {
    this.db
      .prepare(`UPDATE idempotency_requests SET state = 'completed', response_code = ?, response_body = ? WHERE key = ?`)
      .run(code, JSON.stringify(body), key);
  }

  release(key: string): void {
    this.db.prepare('DELETE FROM idempotency_requests WHERE key = ?').run(key);
  }
}

/** All repositories over one database connection. */
export class Repositories {
  readonly customers: CustomerRepository;
  readonly audit: AuditRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly invoices: InvoiceRepository;
  readonly webhookEvents: WebhookEventRepository;
  readonly idempotency: IdempotencyRepository;

  constructor(readonly db: Db) {
    this.customers = new CustomerRepository(db);
    this.audit = new AuditRepository(db);
    this.subscriptions = new SubscriptionRepository(db, this.audit);
    this.invoices = new InvoiceRepository(db);
    this.webhookEvents = new WebhookEventRepository(db);
    this.idempotency = new IdempotencyRepository(db);
  }

  /** Runs `fn` atomically. better-sqlite3 transactions are synchronous, so no await inside. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

