import { Errors } from '../domain/errors';
import type { WebhookOutcome } from '../domain/types';
import type { Repositories } from '../persistence/repositories';
import type { Clock, Notifier } from '../ports';
import type { SignatureVerifier } from '../webhooks/SignatureVerifier';
import type { OutcomeResult, PaymentOutcomeProcessor } from './PaymentOutcomeProcessor';

export const SUPPORTED_EVENT_TYPES = ['payment.succeeded', 'payment.failed', 'payment.refunded'] as const;
export type ProviderEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export interface ProviderEvent {
  event_id: string;
  type: ProviderEventType;
  subscription_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  /** Optional provider fields. */
  charge_id?: string;
  failure_code?: string;
}

export interface WebhookResult {
  event_id: string;
  outcome: WebhookOutcome;
}

/**
 * Inbound provider webhooks. Processing order matters and is tested layer by layer:
 *   1. transport: signature over the raw body (before parsing anything)       -> 401
 *   2. shape: JSON + required fields                                           -> 400
 *   3. type: supported event types                                             -> 422
 *   4. idempotency: a known event_id is acknowledged as a duplicate            -> 200, no side effects
 *   5. references: subscription/invoice exist, belong together, amounts match  -> 422, nothing stored
 *   6. business rules via PaymentOutcomeProcessor, event stored with outcome   -> 200
 * Steps 4-6 run in one transaction.
 */
export class WebhookService {
  constructor(
    private readonly repos: Repositories,
    private readonly processor: PaymentOutcomeProcessor,
    private readonly verifier: SignatureVerifier,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
  ) {}

  handle(rawBody: Buffer | undefined, signature: string | undefined): WebhookResult {
    if (!signature) throw Errors.missingSignature();
    const body = rawBody ?? Buffer.alloc(0);
    if (!this.verifier.isValid(body, signature)) throw Errors.invalidSignature();

    const event = this.parse(body);
    const at = this.clock.now().toISOString();

    const { result, notifications } = this.repos.inTransaction(() => {
      const existing = this.repos.webhookEvents.find(event.event_id);
      if (existing) {
        this.repos.webhookEvents.recordRedelivery(event.event_id, at);
        return { result: { event_id: event.event_id, outcome: 'duplicate' as const }, notifications: [] };
      }

      const invoice = this.repos.invoices.find(event.invoice_id);
      if (!invoice || invoice.subscription_id !== event.subscription_id) {
        throw Errors.unknownReference(
          `Invoice '${event.invoice_id}' does not exist for subscription '${event.subscription_id}'`,
        );
      }
      if (invoice.amount !== event.amount || invoice.currency !== event.currency) {
        throw Errors.amountMismatch(
          `Event is for ${event.amount} ${event.currency} but invoice is ${invoice.amount} ${invoice.currency}`,
        );
      }

      const ctx = { source: 'webhook' as const, sourceRef: event.event_id, at };
      let applied: OutcomeResult;
      switch (event.type) {
        case 'payment.succeeded':
          applied = this.processor.applySuccess(invoice, event.charge_id ?? `ch_${event.event_id}`, ctx);
          break;
        case 'payment.failed':
          applied = this.processor.applyFailure(invoice, event.failure_code ?? 'provider_failed', ctx);
          break;
        case 'payment.refunded':
          applied = this.processor.applyRefund(invoice, ctx);
          break;
      }

      this.repos.webhookEvents.insert({
        event_id: event.event_id,
        type: event.type,
        subscription_id: event.subscription_id,
        invoice_id: event.invoice_id,
        outcome: applied.outcome,
        payload: body.toString('utf8'),
        first_received_at: at,
      });
      return { result: { event_id: event.event_id, outcome: applied.outcome }, notifications: applied.notifications };
    });

    notifications.forEach((n) => this.notifier.notify(n));
    return result;
  }

  private parse(raw: Buffer): ProviderEvent {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch {
      throw Errors.malformedPayload(['body is not valid JSON']);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw Errors.malformedPayload(['body must be a JSON object']);
    }
    const d = data as Record<string, unknown>;
    const problems: string[] = [];
    for (const f of ['event_id', 'type', 'subscription_id', 'invoice_id', 'currency']) {
      if (typeof d[f] !== 'string' || (d[f] as string).length === 0) problems.push(`${f} must be a non-empty string`);
    }
    if (typeof d.amount !== 'number' || !Number.isInteger(d.amount) || d.amount <= 0) {
      problems.push('amount must be a positive integer (minor units)');
    }
    if (problems.length) throw Errors.malformedPayload(problems);
    if (!SUPPORTED_EVENT_TYPES.includes(d.type as ProviderEventType)) throw Errors.unsupportedEventType(String(d.type));
    return d as unknown as ProviderEvent;
  }
}
