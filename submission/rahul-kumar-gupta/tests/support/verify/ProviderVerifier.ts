import type { Invoice, Subscription } from '../../../src/domain/types';
import type { ChargeRequest } from '../../../src/ports';
import type { MockPaymentProvider } from '../doubles/MockPaymentProvider';

/** Assertions on what was sent to the payment provider: how often, and with exactly what. */
export class ProviderVerifier {
  constructor(private readonly provider: MockPaymentProvider) {}

  expectNoCharges(): void {
    expect(this.provider.charge).not.toHaveBeenCalled();
  }

  expectChargeCount(n: number): void {
    expect(this.provider.charge).toHaveBeenCalledTimes(n);
  }

  /** The request the service should send for this billing attempt, derived from our own records. */
  static expectedRequest(sub: Pick<Subscription, 'customer_id' | 'payment_method_id'>, invoice: Invoice): ChargeRequest {
    return {
      customerId: sub.customer_id,
      paymentMethodId: sub.payment_method_id,
      amount: invoice.amount,
      currency: invoice.currency,
      idempotencyKey: invoice.idempotency_key,
      reference: invoice.id,
    };
  }

  /** Exactly `times` calls for this invoice, each with exactly these arguments. */
  expectChargedFor(invoice: Invoice, sub: Pick<Subscription, 'customer_id' | 'payment_method_id'>, times = 1): void {
    const calls = this.provider.callsFor(invoice.id);
    expect(calls).toHaveLength(times);
    const expected = ProviderVerifier.expectedRequest(sub, invoice);
    calls.forEach((c) => expect(c).toEqual(expected));
  }

  /** The nth (0-based) provider call overall had these arguments. */
  expectCall(index: number, expected: ChargeRequest): void {
    expect(this.provider.calls[index]).toEqual(expected);
  }
}
