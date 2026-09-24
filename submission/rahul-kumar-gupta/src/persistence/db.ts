import Database from 'better-sqlite3';
import { SUBSCRIPTION_STATUSES, SubscriptionStateMachine } from '../domain/SubscriptionStateMachine';

export type Db = Database.Database;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * Defence in depth: the database itself refuses any status change that is not in the
 * transition table, so even a buggy code path (or a hand-written UPDATE) cannot move
 * a subscription from `canceled` back to `active`.
 */
function statusGuardTrigger(): string {
  const legal = SubscriptionStateMachine.legalStatusPairs().map(([from, to]) => `${from}->${to}`);
  return `
    CREATE TRIGGER subscriptions_status_guard
    BEFORE UPDATE OF status ON subscriptions
    WHEN NEW.status <> OLD.status AND (OLD.status || '->' || NEW.status) NOT IN (${list(legal)})
    BEGIN
      SELECT RAISE(ABORT, 'illegal subscription status transition');
    END;`;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE customers (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE payment_methods (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    status      TEXT NOT NULL CHECK (status IN ('valid', 'expired'))
  );

  CREATE TABLE subscriptions (
    id                    TEXT PRIMARY KEY,
    customer_id           TEXT NOT NULL REFERENCES customers(id),
    plan                  TEXT NOT NULL,
    payment_method_id     TEXT NOT NULL REFERENCES payment_methods(id),
    status                TEXT NOT NULL CHECK (status IN (${list(SUBSCRIPTION_STATUSES)})),
    trial_ends_at         TEXT,
    current_period_start  TEXT,
    current_period_end    TEXT,
    next_retry_at         TEXT,
    canceled_at           TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
  );

  CREATE TABLE invoices (
    id                  TEXT PRIMARY KEY,
    subscription_id     TEXT NOT NULL REFERENCES subscriptions(id),
    amount              INTEGER NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'void')),
    attempt             INTEGER NOT NULL CHECK (attempt >= 1),
    idempotency_key     TEXT NOT NULL UNIQUE,
    provider_charge_id  TEXT,
    failure_code        TEXT,
    created_at          TEXT NOT NULL,
    paid_at             TEXT,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX invoices_by_subscription ON invoices(subscription_id);

  -- Tracks every processed provider event. event_id is the idempotency key for inbound webhooks.
  CREATE TABLE webhook_events (
    event_id           TEXT PRIMARY KEY,
    type               TEXT NOT NULL,
    subscription_id    TEXT NOT NULL REFERENCES subscriptions(id),
    invoice_id         TEXT NOT NULL REFERENCES invoices(id),
    outcome            TEXT NOT NULL,
    delivery_count     INTEGER NOT NULL DEFAULT 1,
    payload            TEXT NOT NULL,
    first_received_at  TEXT NOT NULL,
    last_received_at   TEXT NOT NULL
  );

  CREATE TABLE subscription_audit (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id  TEXT NOT NULL REFERENCES subscriptions(id),
    kind             TEXT NOT NULL,
    from_status      TEXT,
    to_status        TEXT NOT NULL,
    trigger          TEXT NOT NULL,
    source           TEXT NOT NULL,
    source_ref       TEXT,
    created_at       TEXT NOT NULL
  );

  -- Idempotency-Key support for POST /subscriptions (client retries of the create call).
  CREATE TABLE idempotency_requests (
    key            TEXT PRIMARY KEY,
    request_hash   TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
    response_code  INTEGER,
    response_body  TEXT,
    created_at     TEXT NOT NULL
  );

  ${statusGuardTrigger()}
`;

/** A fresh, fully migrated in-memory database. Each test gets its own. */
export function createDatabase(filename = ':memory:'): Db {
  const db = new Database(filename);
  db.exec(SCHEMA);
  return db;
}
