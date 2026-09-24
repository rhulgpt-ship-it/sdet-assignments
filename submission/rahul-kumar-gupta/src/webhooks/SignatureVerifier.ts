import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 over the exact raw request body, hex encoded. */
export function signPayload(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export class SignatureVerifier {
  constructor(private readonly secret: string) {}

  isValid(rawBody: Buffer, signature: string): boolean {
    const expected = Buffer.from(signPayload(rawBody, this.secret), 'hex');
    let given: Buffer;
    try {
      given = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    // Constant-time compare; length check first because timingSafeEqual throws on mismatch.
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
