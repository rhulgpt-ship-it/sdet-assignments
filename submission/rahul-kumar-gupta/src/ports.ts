/**
 * Seams (dependency-injection points) between the service and the outside world.
 * Production would plug in real adapters; the test suite plugs in doubles.
 */

// ---- Payment provider (outbound) -----------------------------------------------------------

export interface ChargeRequest {
  customerId: string;
  paymentMethodId: string;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  /** Stable per billing attempt: re-sending the same key must never charge twice at the provider. */
  idempotencyKey: string;
  /** Our invoice id, echoed back by the provider in webhooks. */
  reference: string;
}

export type ChargeResult =
  | { status: 'succeeded'; chargeId: string }
  | { status: 'declined'; declineCode: string };

/** Thrown by a provider client when the outcome of a charge is unknown (network timeout, 5xx). */
export class ProviderTimeoutError extends Error {
  constructor(message = 'Payment provider did not respond in time') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

// ---- Clock ---------------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ---- Notifications (a side effect that must not repeat on duplicate webhooks) ---------------

export interface SubscriptionNotification {
  subscriptionId: string;
  type: 'subscription.activated' | 'subscription.past_due' | 'subscription.canceled';
}

export interface Notifier {
  notify(notification: SubscriptionNotification): void;
}

// ---- IDs -----------------------------------------------------------------------------------

export interface IdGenerator {
  next(prefix: 'sub' | 'inv'): string;
}
