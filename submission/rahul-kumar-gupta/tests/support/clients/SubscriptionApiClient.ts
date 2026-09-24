import request from 'supertest';
import type { Express } from 'express';
import type { SubscriptionView } from '../../../src/services/SubscriptionService';
import type { BillingRunEntry } from '../../../src/services/BillingService';
import type { WebhookResult } from '../../../src/services/WebhookService';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  status: number;
  /** Parsed JSON body. On non-2xx responses read `error` instead. */
  body: T;
  error: ApiError | undefined;
  headers: Record<string, string>;
}

/**
 * Typed HTTP client for the service. Specs call intent-level methods; the transport
 * (supertest, headers, content types) stays in here.
 */
export class SubscriptionApiClient {
  constructor(private readonly app: Express) {}

  createSubscription(body: unknown, options: { idempotencyKey?: string } = {}): Promise<ApiResponse<SubscriptionView>> {
    let req = request(this.app).post('/subscriptions').set('Content-Type', 'application/json');
    if (options.idempotencyKey) req = req.set('Idempotency-Key', options.idempotencyKey);
    return this.wrap(req.send(JSON.stringify(body)));
  }

  /** Sends bytes exactly as given, for malformed-body tests. */
  createSubscriptionRaw(rawBody: string, contentType = 'application/json'): Promise<ApiResponse<SubscriptionView>> {
    return this.wrap(request(this.app).post('/subscriptions').set('Content-Type', contentType).send(rawBody));
  }

  getSubscription(id: string): Promise<ApiResponse<SubscriptionView>> {
    return this.wrap(request(this.app).get(`/subscriptions/${encodeURIComponent(id)}`));
  }

  cancelSubscription(id: string): Promise<ApiResponse<SubscriptionView>> {
    return this.wrap(request(this.app).post(`/subscriptions/${encodeURIComponent(id)}/cancel`));
  }

  runBilling(): Promise<ApiResponse<{ results: BillingRunEntry[] }>> {
    return this.wrap(request(this.app).post('/internal/billing/run'));
  }

  postWebhook(rawBody: string, signature: string | undefined): Promise<ApiResponse<WebhookResult>> {
    let req = request(this.app).post('/webhooks/payment-provider').set('Content-Type', 'application/json');
    if (signature !== undefined) req = req.set('X-Provider-Signature', signature);
    return this.wrap(req.send(rawBody));
  }

  private async wrap<T>(pending: request.Test): Promise<ApiResponse<T>> {
    const res = await pending;
    return {
      status: res.status,
      body: res.body as T,
      error: (res.body as { error?: ApiError })?.error,
      headers: res.headers as Record<string, string>,
    };
  }
}
