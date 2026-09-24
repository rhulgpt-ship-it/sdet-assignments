import type { ChargeRequest, ChargeResult, PaymentProvider } from '../../../src/ports';
import { ProviderTimeoutError } from '../../../src/ports';

type ScriptedOutcome =
  | { kind: 'succeed' }
  | { kind: 'decline'; code: string }
  /** `processedAs` models "the provider did charge, but our client timed out before hearing back". */
  | { kind: 'timeout'; processedAs?: 'succeeded' | 'declined' };

/**
 * Test double for the outbound payment provider (implements the real PaymentProvider seam).
 *
 * - Outcomes are scripted per call (willSucceed / willDecline / willTimeout), default = succeed.
 * - Every call is recorded through jest.fn, so tests assert call count AND arguments.
 * - Like a real provider, it is idempotent on `idempotencyKey`: re-sending a key it has already
 *   processed returns the original result instead of charging again. This is what makes a
 *   same-key retry after a timeout safe, and the tests prove the service relies on it correctly.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly charge = jest.fn<Promise<ChargeResult>, [ChargeRequest]>((req) => this.handle(req));

  private script: ScriptedOutcome[] = [];
  private fallback: ScriptedOutcome = { kind: 'succeed' };
  private readonly ledger = new Map<string, ChargeResult>();
  private readonly timeoutsByKey = new Map<string, number>();
  private chargeSeq = 0;

  willSucceed(): this {
    this.script.push({ kind: 'succeed' });
    return this;
  }

  willDecline(code = 'card_declined'): this {
    this.script.push({ kind: 'decline', code });
    return this;
  }

  willTimeout(options: { processedAs?: 'succeeded' | 'declined' } = {}): this {
    this.script.push({ kind: 'timeout', processedAs: options.processedAs });
    return this;
  }

  /** Outcome used once the script is exhausted. */
  alwaysDecline(code = 'card_declined'): this {
    this.fallback = { kind: 'decline', code };
    return this;
  }

  // ---- recorded interactions ---------------------------------------------------------------

  get calls(): ChargeRequest[] {
    return this.charge.mock.calls.map(([req]) => req);
  }

  callsFor(invoiceId: string): ChargeRequest[] {
    return this.calls.filter((c) => c.reference === invoiceId);
  }

  timeoutsFor(idempotencyKey: string): number {
    return this.timeoutsByKey.get(idempotencyKey) ?? 0;
  }

  /** What the provider actually did, per idempotency key. At most one result per key, ever. */
  processedResult(idempotencyKey: string): ChargeResult | undefined {
    return this.ledger.get(idempotencyKey);
  }

  pendingScript(): number {
    return this.script.length;
  }

  // ---- behaviour ---------------------------------------------------------------------------

  private async handle(req: ChargeRequest): Promise<ChargeResult> {
    const previous = this.ledger.get(req.idempotencyKey);
    if (previous) return previous;

    const next = this.script.shift() ?? this.fallback;
    switch (next.kind) {
      case 'succeed':
        return this.record(req, { status: 'succeeded', chargeId: this.nextChargeId() });
      case 'decline':
        return this.record(req, { status: 'declined', declineCode: next.code });
      case 'timeout':
        this.timeoutsByKey.set(req.idempotencyKey, this.timeoutsFor(req.idempotencyKey) + 1);
        if (next.processedAs === 'succeeded') this.record(req, { status: 'succeeded', chargeId: this.nextChargeId() });
        if (next.processedAs === 'declined') this.record(req, { status: 'declined', declineCode: 'card_declined' });
        throw new ProviderTimeoutError();
    }
  }

  private record(req: ChargeRequest, result: ChargeResult): ChargeResult {
    this.ledger.set(req.idempotencyKey, result);
    return result;
  }

  private nextChargeId(): string {
    this.chargeSeq += 1;
    return `ch_mock_${String(this.chargeSeq).padStart(4, '0')}`;
  }
}
