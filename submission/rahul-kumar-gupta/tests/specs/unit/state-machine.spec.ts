import {
  IllegalTransitionError,
  LIFECYCLE_TRIGGERS,
  SUBSCRIPTION_STATUSES,
  SubscriptionStateMachine,
  TRANSITIONS,
} from '../../../src/domain/SubscriptionStateMachine';

/**
 * Pure unit level: the transition table itself. The lifecycle specs prove the service
 * honours it end to end; this proves the table is exactly the diagram in the brief.
 */
describe('SubscriptionStateMachine (transition table)', () => {
  it('encodes exactly the seven transitions from the lifecycle diagram', () => {
    expect(TRANSITIONS.map((t) => `${t.from} --${t.trigger}--> ${t.to}`).sort()).toEqual(
      [
        'trialing --charge_succeeded--> active',
        'trialing --charge_failed--> past_due',
        'active --charge_failed--> past_due',
        'past_due --charge_succeeded--> active',
        'past_due --retries_exhausted--> canceled',
        'active --cancel_requested--> canceled',
        'trialing --cancel_requested--> canceled',
      ].sort(),
    );
  });

  it.each(TRANSITIONS.map((t) => [t.from, t.trigger, t.to] as const))('%s + %s -> %s', (from, trigger, to) => {
    expect(SubscriptionStateMachine.next(from, trigger)).toBe(to);
    expect(SubscriptionStateMachine.can(from, trigger)).toBe(true);
  });

  const illegal = SUBSCRIPTION_STATUSES.flatMap((from) =>
    LIFECYCLE_TRIGGERS.filter((trigger) => !TRANSITIONS.some((t) => t.from === from && t.trigger === trigger)).map(
      (trigger) => [from, trigger] as const,
    ),
  );

  it('rejects every (status, trigger) pair not in the table', () => {
    // 4 statuses x 4 triggers = 16 pairs, 7 legal -> 9 illegal.
    expect(illegal).toHaveLength(9);
  });

  it.each(illegal)('rejects %s + %s', (from, trigger) => {
    expect(SubscriptionStateMachine.can(from, trigger)).toBe(false);
    expect(() => SubscriptionStateMachine.next(from, trigger)).toThrow(IllegalTransitionError);
  });

  it('treats canceled as the only terminal state', () => {
    expect(SUBSCRIPTION_STATUSES.filter((s) => SubscriptionStateMachine.isTerminal(s))).toEqual(['canceled']);
  });

  it('has no transition back into trialing', () => {
    expect(TRANSITIONS.some((t) => t.to === 'trialing')).toBe(false);
  });
});
