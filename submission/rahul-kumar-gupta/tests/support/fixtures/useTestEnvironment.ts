import type { TestEnvironmentOptions } from './TestEnvironment';
import { TestEnvironment } from './TestEnvironment';

/**
 * Per-test lifecycle for specs:
 *   beforeEach -> brand-new TestEnvironment (fresh in-memory DB, fresh doubles)
 *   afterEach  -> run every business invariant against whatever the test left behind, then close
 *
 * Usage:
 *   const t = useTestEnvironment();
 *   it('...', async () => { const { api, given, verify } = t.env; ... });
 */
export function useTestEnvironment(options: TestEnvironmentOptions = {}): { readonly env: TestEnvironment } {
  let current: TestEnvironment | undefined;

  beforeEach(() => {
    current = TestEnvironment.create(options);
  });

  afterEach(async () => {
    try {
      await current?.invariants.checkAll();
    } finally {
      current?.close();
      current = undefined;
    }
  });

  return {
    get env(): TestEnvironment {
      if (!current) throw new Error('TestEnvironment is only available inside a test');
      return current;
    },
  };
}
