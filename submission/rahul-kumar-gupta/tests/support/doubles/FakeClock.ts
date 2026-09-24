import type { Clock } from '../../../src/ports';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Deterministic time. Trial ends and retries happen when a test says so, never by sleeping. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceMinutes(n: number): this {
    this.current += n * MINUTE_MS;
    return this;
  }

  advanceDays(n: number): this {
    this.current += n * DAY_MS;
    return this;
  }

  /** Moves to an absolute ISO time (e.g. a subscription's trial_ends_at). Never goes backwards. */
  advanceTo(iso: string): this {
    const target = new Date(iso).getTime();
    if (target < this.current) throw new Error(`FakeClock cannot move backwards to ${iso}`);
    this.current = target;
    return this;
  }
}
