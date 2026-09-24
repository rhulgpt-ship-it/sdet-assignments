# Subscription & Billing Service: Automated Validation Suite

**Author:** Rahul Kumar Gupta
**Stack:** TypeScript, Jest (ts-jest), Supertest, Express, better-sqlite3 (in-memory)
**Approach chosen:** Option 3, hybrid. A minimal service fixture sits alongside test doubles for the payment provider, clock, notifier and ID generation.

The design rationale and test strategy are in [APPROACH.md](./APPROACH.md). This file covers how to run the suite and where to find things.

---

## Quick start

Requirements: **Node.js 20 or newer** (see `.nvmrc`) and npm. No database, Docker or network access is needed.

```bash
cd submission/rahul-kumar-gupta
npm ci               # installs exact versions from package-lock.json
npm test             # 135 tests, ~5s
npm run validate     # lint + type-check + tests (what CI would run)
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run test:verbose` | Prints every scenario name, which reads as a behaviour spec |
| `npm run test:coverage` | Coverage for `src/` (currently ~97% statements, ~88% branches) |
| `npm run build` | `tsc --noEmit`: strict type-check of service and tests |
| `npm run lint` | ESLint, including a rule that stops specs from importing `supertest` or `better-sqlite3` |

**Persistence setup and seed data:** nothing to set up. Each test creates a fresh in-memory SQLite database through `TestEnvironment.create()`, which runs the schema in `src/persistence/db.ts`. Customers and payment methods are seeded per test through `CustomerBuilder`. Subscriptions are never seeded; they are always created through the public API. Nothing is shared between tests, so there is nothing to clean up.

---

## Layout

```
src/                                  minimal service fixture (the system under test)
  domain/SubscriptionStateMachine.ts  explicit transition table: the only definition of legal status changes
  domain/plans/PlanPolicy.ts          Strategy: BasicPlan / ProPlan / PlanRegistry (price, trial, period)
  ports.ts                            seams: PaymentProvider, Clock, Notifier, IdGenerator
  persistence/db.ts                   schema, constraints, and a DB trigger generated from the transition table
  persistence/repositories.ts         Repository classes: all SQL lives here
  services/PaymentOutcomeProcessor.ts one place where charge outcomes (sync or webhook) are applied
  services/BillingService.ts          charges through the PaymentProvider seam; scheduled billing run
  services/SubscriptionService.ts     create (+ Idempotency-Key), get, cancel
  services/WebhookService.ts          signature -> shape -> type -> dedupe -> references -> rules
  webhooks/SignatureVerifier.ts       HMAC-SHA256 over the raw body, constant-time compare
  app.ts                              Express app + dependency injection (createApp(deps))

tests/support/                        the test framework
  fixtures/TestEnvironment.ts         Factory: wires an isolated world per test
  fixtures/useTestEnvironment.ts      beforeEach: new world; afterEach: run all invariants, then close
  fixtures/ScenarioSteps.ts           "given" steps that reach states via API / billing / webhooks only
  clients/SubscriptionApiClient.ts    typed HTTP client (all supertest usage lives here)
  doubles/MockPaymentProvider.ts      scripted success/decline/timeout, call recording, provider-side idempotency
  doubles/WebhookSimulator.ts         signs and delivers events: repeated and concurrent delivery
  doubles/FakeClock.ts, RecordingNotifier.ts, SequentialIds.ts
  builders/                           Builder: CustomerBuilder, SubscriptionRequestBuilder, WebhookEventBuilder
  verify/SubscriptionVerifier.ts      API vs DB vs audit agreement, snapshots for "nothing changed"
  verify/ProviderVerifier.ts          call count and exact-argument assertions
  verify/InvariantChecker.ts          global business invariants, run after every test

tests/specs/                          scenarios, grouped by concern
  api/          contract, validation, webhook transport, Idempotency-Key on create      (38)
  lifecycle/    every valid transition (table-driven), invalid transitions, plan rules (25)
  webhooks/     idempotency / duplicate delivery, out-of-order and stale events        (12)
  provider/     success / decline / timeout, exact arguments, no-call cases            (10)
  persistence/  per-stage DB state, DB-level guards                                     (8)
  e2e/          multi-step journeys across all layers                                   (3)
  unit/         transition table, plan strategies, signature verification              (32)
  framework/    tests of the InvariantChecker itself                                    (7)
```

---

## How a test reads

```ts
it('same payment.succeeded delivered twice: transition happens exactly once', async () => {
  const { given, webhooks, verify, notifier, provider } = t.env;
  const g = await given.trialingWithUnknownCharge();          // real path: create -> trial ends -> charge times out
  const event = aWebhook().paymentSucceeded().forInvoice(g.invoice!);

  const [first, second] = await webhooks.deliverRepeatedly(event, 2);

  expect(first.body.outcome).toBe('applied');
  expect(second.body.outcome).toBe('duplicate');
  await verify.expectStatus(g.subscription.id, 'active');       // API == DB == last audit entry
  verify.expectWebhookEvent(event.eventId, { outcome: 'applied', delivery_count: 2 });
  expect(notifier.for(g.subscription.id)).toEqual(['subscription.activated']);
});
// afterEach: InvariantChecker re-checks every subscription, invoice, provider call and notification.
```

Specs contain no HTTP calls and no SQL. The two exceptions are `persistence/db-guard.spec.ts` and `framework/invariant-checker.spec.ts`, which use raw SQL on purpose because they test the safety nets themselves.

---

## Coverage map to the brief

| Brief | Where | Notes |
|---|---|---|
| A. Creation & activation | `lifecycle/plan-rules`, `provider/charge-outcomes`, `api/subscriptions.contract` | Initial state per plan, exact provider arguments, API == DB |
| B. Validation failures | `api/validation`, `lifecycle/invalid-transitions` | Each asserts no rows, no provider call, no notification |
| C. Payment failure | `provider/charge-outcomes` (decline), `lifecycle/valid-transitions` | past_due, failed attempt recorded, no success row |
| D. Webhook idempotency *(mandatory)* | `webhooks/idempotency` | x2, x5, concurrent x4, after state moved on, refunds |
| E. State-machine invariants *(mandatory)* | `lifecycle/valid-transitions`, `lifecycle/invalid-transitions`, `webhooks/out-of-order`, `unit/state-machine` | All 7 transitions via each possible driver; failed-after-succeeded does not regress |
| F. Mocked provider interaction | `provider/charge-outcomes`, `InvariantChecker` I4 | Exact args, once per attempt, same key on re-send, no call when not needed |
| G. Persistence & auditability | `persistence/lifecycle-persistence`, `InvariantChecker` | Checked at every stage of a 6-step lifecycle |
| Bonus: concurrent webhooks | `webhooks/idempotency`, `webhooks/out-of-order`, `api/idempotent-create` | See limitations: processing is serialised |

## Does the suite actually catch bugs?

To check that the tests fail when the code is wrong, I injected 14 deliberate bugs into the service, one at a time, and ran the full suite against each:

| Injected bug | Failing tests |
|---|---|
| Duplicate webhooks re-processed | 7 |
| Canceled-subscription guard removed | 3 |
| Settled-invoice guard removed (out-of-order events apply) | 7 |
| Provider timeout treated as a decline | 4 |
| New idempotency key on every re-send | 77 |
| Cancel does not void the in-flight attempt | 2 |
| Billing ignores plan price | 14 |
| Webhook signature not verified | 4 |
| A pending attempt does not block a new charge | 1 |
| Retries never exhaust | 4 |
| Webhook amount mismatch accepted | 2 |
| `past_due -> canceled` added to the transition table | 6 |
| Notification fired for ignored webhooks | 17 |
| Idempotency-Key replay disabled | 3 |

Every bug was caught. This was a manual exercise and is not part of `npm test`. The next step would be Stryker mutation testing in CI.

---

## Assumptions (details in APPROACH.md, section 3)

- `basic`: 1900 USD per 30 days with a 14-day trial. `pro`: 4900 USD per 30 days, charged at creation. A zero-day trial still passes through `trialing`.
- A provider **timeout** means the outcome is unknown: the attempt stays `pending` and the status does not change. The next billing run re-sends with the **same** idempotency key, or a webhook settles it.
- Retries: after the first failed attempt of a cycle, 3 retries one day apart. If the 4th attempt fails, the subscription moves `past_due -> canceled`.
- `payment.refunded` marks the invoice `refunded` and is audited, but it causes **no** lifecycle transition, because the diagram defines none.
- Cancel is only allowed from `trialing` or `active`, as in the diagram. Canceling a `past_due` subscription returns 409.
- `POST /internal/billing/run` is a test-only route that stands in for a scheduler. With `FakeClock`, time-based transitions are deterministic.

## Known limitations

- Webhook processing runs in one synchronous SQLite transaction inside a single Node process, so "concurrent" deliveries are serialised. The concurrency tests prove the observable contract, not DB-level race handling. With Postgres, the same tests would need row locks or `INSERT ... ON CONFLICT` on `event_id`.
- If a customer cancels while a charge is in flight and the provider then reports success, the subscription stays canceled and the late event is recorded as `ignored_subscription_canceled`. A real system would also trigger a refund. That is out of scope here.
- There is no contract test against a real provider API (e.g. Pact), no proration, no taxes and no multi-currency. These are non-goals in the brief.
