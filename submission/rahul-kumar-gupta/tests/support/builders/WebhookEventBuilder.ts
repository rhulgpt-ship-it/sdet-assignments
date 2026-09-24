import type { ProviderEvent } from '../../../src/services/WebhookService';
import { signPayload } from '../../../src/webhooks/SignatureVerifier';

let eventSeq = 0;

type Signing =
  | { kind: 'valid' }
  | { kind: 'none' }
  | { kind: 'forged' }
  | { kind: 'secret'; secret: string }
  | { kind: 'tampered' };

export interface InvoiceRef {
  id: string;
  subscription_id: string;
  amount: number;
  currency: string;
}

export interface WebhookDelivery {
  body: string;
  signature: string | undefined;
}

/**
 * Builder for provider webhook events AND for how they are delivered (signed, unsigned,
 * forged, tampered, malformed). Scenarios read as intent:
 *
 *   aWebhook().paymentFailed('insufficient_funds').forInvoice(invoice)
 *   aWebhook().paymentSucceeded().forInvoice(invoice).withForgedSignature()
 */
export class WebhookEventBuilder {
  private event: Record<string, unknown>;
  private signing: Signing = { kind: 'valid' };
  private rawOverride: string | undefined;

  constructor() {
    eventSeq += 1;
    this.event = {
      event_id: `evt_${String(eventSeq).padStart(5, '0')}`,
      type: 'payment.succeeded',
      subscription_id: 'sub_unset',
      invoice_id: 'inv_unset',
      amount: 4900,
      currency: 'USD',
    };
  }

  // ---- event content ---------------------------------------------------------------------

  paymentSucceeded(chargeId?: string): this {
    this.event.type = 'payment.succeeded';
    if (chargeId) this.event.charge_id = chargeId;
    return this;
  }

  paymentFailed(failureCode = 'card_declined'): this {
    this.event.type = 'payment.failed';
    this.event.failure_code = failureCode;
    return this;
  }

  paymentRefunded(): this {
    this.event.type = 'payment.refunded';
    return this;
  }

  /** Points the event at an invoice, copying its subscription, amount and currency. */
  forInvoice(invoice: InvoiceRef): this {
    this.event.subscription_id = invoice.subscription_id;
    this.event.invoice_id = invoice.id;
    this.event.amount = invoice.amount;
    this.event.currency = invoice.currency;
    return this;
  }

  withEventId(eventId: string): this {
    this.event.event_id = eventId;
    return this;
  }

  withType(type: string): this {
    this.event.type = type;
    return this;
  }

  with(field: string, value: unknown): this {
    this.event[field] = value;
    return this;
  }

  without(field: string): this {
    delete this.event[field];
    return this;
  }

  // ---- delivery variants -----------------------------------------------------------------

  unsigned(): this {
    this.signing = { kind: 'none' };
    return this;
  }

  withForgedSignature(): this {
    this.signing = { kind: 'forged' };
    return this;
  }

  signedWithSecret(secret: string): this {
    this.signing = { kind: 'secret', secret };
    return this;
  }

  /** Correctly signed, then the body is altered in transit (amount changed). */
  withTamperedBody(): this {
    this.signing = { kind: 'tampered' };
    return this;
  }

  /** Replaces the JSON body with arbitrary text; still signed correctly unless told otherwise. */
  withRawBody(raw: string): this {
    this.rawOverride = raw;
    return this;
  }

  // ---- outputs ---------------------------------------------------------------------------

  get eventId(): string {
    return String(this.event.event_id);
  }

  build(): ProviderEvent {
    return { ...this.event } as unknown as ProviderEvent;
  }

  toDelivery(secret: string): WebhookDelivery {
    const body = this.rawOverride ?? JSON.stringify(this.event);
    switch (this.signing.kind) {
      case 'valid':
        return { body, signature: signPayload(body, secret) };
      case 'none':
        return { body, signature: undefined };
      case 'forged':
        return { body, signature: 'f'.repeat(64) };
      case 'secret':
        return { body, signature: signPayload(body, this.signing.secret) };
      case 'tampered': {
        const signature = signPayload(body, secret);
        const tampered = JSON.stringify({ ...this.event, amount: Number(this.event.amount) + 1 });
        return { body: tampered, signature };
      }
    }
  }
}

export const aWebhook = () => new WebhookEventBuilder();
