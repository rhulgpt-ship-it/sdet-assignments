import type { IdGenerator } from '../../../src/ports';

/** Readable, deterministic ids (sub_0001, inv_0003) so failure messages are easy to follow. */
export class SequentialIds implements IdGenerator {
  private readonly counters: Record<string, number> = {};

  next(prefix: 'sub' | 'inv'): string {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
    return `${prefix}_${String(this.counters[prefix]).padStart(4, '0')}`;
  }
}
