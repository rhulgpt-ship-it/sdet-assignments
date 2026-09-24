import type { SubscriptionStatus } from './SubscriptionStateMachine';

export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'void';

export interface Customer {
  id: string;
  email: string;
  created_at: string;
}

export interface PaymentMethod {
  id: string;
  customer_id: string;
  status: 'valid' | 'expired';
}

export interface Subscription {
  id: string;
  customer_id: string;
  plan: string;
  payment_method_id: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_retry_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One row per billing attempt. A retry is a new row with attempt + 1. */
export interface Invoice {
  id: string;
  subscription_id: string;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  attempt: number;
  idempotency_key: string;
  provider_charge_id: string | null;
  failure_code: string | null;
  created_at: string;
  paid_at: string | null;
  updated_at: string;
}

export const WEBHOOK_OUTCOMES = [
  'applied',
  'duplicate',
  'ignored_invoice_already_settled',
  'ignored_subscription_canceled',
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

export interface WebhookEventRecord {
  event_id: string;
  type: string;
  subscription_id: string;
  invoice_id: string;
  outcome: WebhookOutcome;
  delivery_count: number;
  payload: string;
  first_received_at: string;
  last_received_at: string;
}

export type AuditKind = 'created' | 'transition' | 'renewed' | 'invoice_refunded';
export type AuditSource = 'api' | 'billing' | 'webhook';

export interface AuditEntry {
  id: number;
  subscription_id: string;
  kind: AuditKind;
  from_status: SubscriptionStatus | null;
  to_status: SubscriptionStatus;
  trigger: string;
  source: AuditSource;
  source_ref: string | null;
  created_at: string;
}
