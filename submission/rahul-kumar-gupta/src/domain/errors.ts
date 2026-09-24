/** Errors that map to an HTTP response. Anything else is a 500. */
export class DomainError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const Errors = {
  validation: (details: string[]) =>
    new DomainError(400, 'validation_error', 'Request body failed validation', details),
  customerNotFound: (id: string) => new DomainError(404, 'customer_not_found', `Customer '${id}' does not exist`),
  subscriptionNotFound: (id: string) =>
    new DomainError(404, 'subscription_not_found', `Subscription '${id}' does not exist`),
  unknownPlan: (plan: string) => new DomainError(422, 'unknown_plan', `Plan '${plan}' does not exist`),
  invalidPaymentMethod: (id: string) =>
    new DomainError(422, 'invalid_payment_method', `Payment method '${id}' is not usable for this customer`),
  alreadyCanceled: (id: string) =>
    new DomainError(409, 'subscription_already_canceled', `Subscription '${id}' is already canceled`),
  illegalTransition: (id: string, from: string, action: string) =>
    new DomainError(409, 'illegal_transition', `Cannot ${action} subscription '${id}' while it is '${from}'`),
  idempotencyKeyReused: () =>
    new DomainError(422, 'idempotency_key_reused', 'Idempotency-Key was already used with a different request body'),
  requestInProgress: () =>
    new DomainError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed'),
  missingSignature: () => new DomainError(401, 'missing_signature', 'X-Provider-Signature header is required'),
  invalidSignature: () => new DomainError(401, 'invalid_signature', 'Webhook signature verification failed'),
  malformedPayload: (details: string[]) =>
    new DomainError(400, 'malformed_payload', 'Webhook payload is malformed', details),
  unsupportedEventType: (type: string) =>
    new DomainError(422, 'unsupported_event_type', `Webhook event type '${type}' is not supported`),
  unknownReference: (message: string) => new DomainError(422, 'unknown_reference', message),
  amountMismatch: (message: string) => new DomainError(422, 'amount_mismatch', message),
};
