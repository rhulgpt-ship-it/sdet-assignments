import type { Express } from 'express';
import type { Container } from '../../../src/app';
import { createApp } from '../../../src/app';
import type { Db } from '../../../src/persistence/db';
import { createDatabase } from '../../../src/persistence/db';
import type { Repositories } from '../../../src/persistence/repositories';
import type { BillingRules } from '../../../src/services/PaymentOutcomeProcessor';
import { DEFAULT_BILLING_RULES } from '../../../src/services/PaymentOutcomeProcessor';
import type { CustomerBuilder, CustomerSeed } from '../builders/CustomerBuilder';
import { aCustomer } from '../builders/CustomerBuilder';
import { SubscriptionApiClient } from '../clients/SubscriptionApiClient';
import { FakeClock } from '../doubles/FakeClock';
import { MockPaymentProvider } from '../doubles/MockPaymentProvider';
import { RecordingNotifier } from '../doubles/RecordingNotifier';
import { SequentialIds } from '../doubles/SequentialIds';
import { WebhookSimulator } from '../doubles/WebhookSimulator';
import { InvariantChecker } from '../verify/InvariantChecker';
import { ProviderVerifier } from '../verify/ProviderVerifier';
import { SubscriptionVerifier } from '../verify/SubscriptionVerifier';
import { ScenarioSteps } from './ScenarioSteps';

export const TEST_WEBHOOK_SECRET = 'whsec_test_only_do_not_use';

export interface TestEnvironmentOptions {
  billingRules?: Partial<BillingRules>;
}

/**
 * Factory for a fully wired, isolated test world:
 *   real HTTP app + real state machine + real SQLite (fresh, in-memory)
 *   + test doubles for the payment provider, clock, notifier and id generation.
 *
 * Nothing is shared between two environments, so there is nothing to clean up and no stale
 * data from another test can make an assertion pass.
 */
export class TestEnvironment {
  readonly clock = new FakeClock();
  readonly provider = new MockPaymentProvider();
  readonly notifier = new RecordingNotifier();
  readonly billingRules: BillingRules;

  readonly db: Db;
  readonly app: Express;
  readonly container: Container;
  readonly api: SubscriptionApiClient;
  readonly webhooks: WebhookSimulator;

  readonly verify: SubscriptionVerifier;
  readonly providerVerify: ProviderVerifier;
  readonly invariants: InvariantChecker;
  readonly given: ScenarioSteps;

  private constructor(options: TestEnvironmentOptions) {
    this.billingRules = { ...DEFAULT_BILLING_RULES, ...options.billingRules };
    this.db = createDatabase();
    const { app, container } = createApp({
      db: this.db,
      provider: this.provider,
      webhookSecret: TEST_WEBHOOK_SECRET,
      clock: this.clock,
      notifier: this.notifier,
      ids: new SequentialIds(),
      billingRules: this.billingRules,
      enableInternalRoutes: true,
    });
    this.app = app;
    this.container = container;
    this.api = new SubscriptionApiClient(app);
    this.webhooks = new WebhookSimulator(this.api, TEST_WEBHOOK_SECRET);
    this.verify = new SubscriptionVerifier(this.api, container.repos);
    this.providerVerify = new ProviderVerifier(this.provider);
    this.invariants = new InvariantChecker(container.repos, this.api, this.provider, this.notifier, container.plans);
    this.given = new ScenarioSteps(this);
  }

  static create(options: TestEnvironmentOptions = {}): TestEnvironment {
    return new TestEnvironment(options);
  }

  /** Read-only access for verification. Specs never write through this. */
  get repos(): Repositories {
    return this.container.repos;
  }

  /** Seeds a customer and their payment methods straight into persistence (not an API under test). */
  readonly seedCustomer = (builder: CustomerBuilder = aCustomer()): CustomerSeed => {
    const seed = builder.build(this.clock.now().toISOString());
    this.repos.customers.insert(seed.customer);
    seed.paymentMethods.forEach((pm) => this.repos.customers.insertPaymentMethod(pm));
    return seed;
  };

  close(): void {
    this.db.close();
  }
}
