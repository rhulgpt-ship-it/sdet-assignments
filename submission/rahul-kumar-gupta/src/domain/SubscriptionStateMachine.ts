/**
 * Subscription lifecycle expressed as an explicit transition table.
 *
 * This table is the single source of truth for:
 *  - the service (SubscriptionRepository.transition is the only code path that changes `status`),
 *  - the database (a SQLite trigger generated from this table rejects any other status change),
 *  - the tests (the lifecycle spec proves every row here is exercised by at least one scenario).
 *
 * Anything not listed is illegal and throws IllegalTransitionError.
 */

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const LIFECYCLE_TRIGGERS = [
  'charge_succeeded',
  'charge_failed',
  'retries_exhausted',
  'cancel_requested',
] as const;
export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

export interface Transition {
  readonly from: SubscriptionStatus;
  readonly trigger: LifecycleTrigger;
  readonly to: SubscriptionStatus;
}

export const TRANSITIONS: readonly Transition[] = Object.freeze([
  { from: 'trialing', trigger: 'charge_succeeded', to: 'active' },
  { from: 'trialing', trigger: 'charge_failed', to: 'past_due' },
  { from: 'active', trigger: 'charge_failed', to: 'past_due' },
  { from: 'past_due', trigger: 'charge_succeeded', to: 'active' },
  { from: 'past_due', trigger: 'retries_exhausted', to: 'canceled' },
  { from: 'active', trigger: 'cancel_requested', to: 'canceled' },
  { from: 'trialing', trigger: 'cancel_requested', to: 'canceled' },
]);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: SubscriptionStatus,
    readonly trigger: LifecycleTrigger,
  ) {
    super(`Illegal subscription transition: '${trigger}' is not allowed from '${from}'`);
    this.name = 'IllegalTransitionError';
  }
}

export class SubscriptionStateMachine {
  private static readonly table = new Map<string, SubscriptionStatus>(
    TRANSITIONS.map((t) => [SubscriptionStateMachine.key(t.from, t.trigger), t.to]),
  );

  /** Returns the next status, or throws if the trigger is not legal from `from`. */
  static next(from: SubscriptionStatus, trigger: LifecycleTrigger): SubscriptionStatus {
    const to = this.table.get(this.key(from, trigger));
    if (!to) throw new IllegalTransitionError(from, trigger);
    return to;
  }

  static can(from: SubscriptionStatus, trigger: LifecycleTrigger): boolean {
    return this.table.has(this.key(from, trigger));
  }

  static isTerminal(status: SubscriptionStatus): boolean {
    return !TRANSITIONS.some((t) => t.from === status);
  }

  /** Legal (from -> to) status pairs; used to generate the DB-level guard. */
  static legalStatusPairs(): Array<[SubscriptionStatus, SubscriptionStatus]> {
    return TRANSITIONS.map((t) => [t.from, t.to]);
  }

  private static key(from: SubscriptionStatus, trigger: LifecycleTrigger): string {
    return `${from}:${trigger}`;
  }
}
