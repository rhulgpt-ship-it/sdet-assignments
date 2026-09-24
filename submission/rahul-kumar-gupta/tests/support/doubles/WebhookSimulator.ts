import type { WebhookResult } from '../../../src/services/WebhookService';
import type { ApiResponse, SubscriptionApiClient } from '../clients/SubscriptionApiClient';
import type { WebhookEventBuilder } from '../builders/WebhookEventBuilder';

/**
 * Plays the payment provider's side of webhook delivery: signs with the shared secret and
 * posts, including the unpleasant real-world variants (redelivery, bursts, concurrency).
 */
export class WebhookSimulator {
  constructor(
    private readonly api: SubscriptionApiClient,
    private readonly secret: string,
  ) {}

  deliver(event: WebhookEventBuilder): Promise<ApiResponse<WebhookResult>> {
    const { body, signature } = event.toDelivery(this.secret);
    return this.api.postWebhook(body, signature);
  }

  /** The provider redelivering the same event N times, one after another. */
  async deliverRepeatedly(event: WebhookEventBuilder, times: number): Promise<ApiResponse<WebhookResult>[]> {
    const responses: ApiResponse<WebhookResult>[] = [];
    for (let i = 0; i < times; i += 1) responses.push(await this.deliver(event));
    return responses;
  }

  /** Several deliveries in flight at once (bonus: concurrent/racing webhooks). */
  deliverConcurrently(events: WebhookEventBuilder[]): Promise<ApiResponse<WebhookResult>[]> {
    return Promise.all(events.map((e) => this.deliver(e)));
  }
}
