import type { Notifier, SubscriptionNotification } from '../../../src/ports';

/** Records side effects so tests can prove a duplicate webhook does not fire them twice. */
export class RecordingNotifier implements Notifier {
  readonly sent: SubscriptionNotification[] = [];

  notify(notification: SubscriptionNotification): void {
    this.sent.push(notification);
  }

  for(subscriptionId: string): SubscriptionNotification['type'][] {
    return this.sent.filter((n) => n.subscriptionId === subscriptionId).map((n) => n.type);
  }
}
