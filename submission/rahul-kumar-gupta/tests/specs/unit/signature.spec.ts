import { SignatureVerifier, signPayload } from '../../../src/webhooks/SignatureVerifier';

describe('SignatureVerifier (HMAC-SHA256 over the raw body)', () => {
  const secret = 'whsec_unit';
  const verifier = new SignatureVerifier(secret);
  const body = Buffer.from('{"event_id":"evt_1","amount":4900}');

  it('accepts a signature computed with the shared secret', () => {
    expect(verifier.isValid(body, signPayload(body, secret))).toBe(true);
  });

  it('rejects a signature computed with another secret', () => {
    expect(verifier.isValid(body, signPayload(body, 'whsec_attacker'))).toBe(false);
  });

  it('rejects a valid signature once a single byte of the body changes', () => {
    const signature = signPayload(body, secret);
    expect(verifier.isValid(Buffer.from('{"event_id":"evt_1","amount":4901}'), signature)).toBe(false);
  });

  it.each(['', 'not-hex', 'abcd', 'f'.repeat(64)])('rejects malformed or wrong signature %p without throwing', (sig) => {
    expect(verifier.isValid(body, sig)).toBe(false);
  });

  it('is sensitive to whitespace, i.e. it verifies raw bytes and not re-serialised JSON', () => {
    const pretty = Buffer.from('{ "event_id": "evt_1", "amount": 4900 }');
    expect(verifier.isValid(pretty, signPayload(body, secret))).toBe(false);
  });
});
