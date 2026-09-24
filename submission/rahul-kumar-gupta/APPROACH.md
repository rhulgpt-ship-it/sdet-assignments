# Subscription & Billing Service: Test Strategy & Approach

**Candidate:** Rahul Kumar Gupta
**Location:** `submission/rahul-kumar-gupta/`
**Status:** Written before implementation (first commit on this branch), then updated to match the code. Section 15 lists what changed from the first draft.

---

## 1. My understanding of the problem

The system under test is a stateful, billed resource. A subscription moves through a lifecycle (`trialing → active → past_due → canceled`) driven by **two independent inputs**:

1. **Synchronous calls**: API create/get/cancel, and the scheduled billing run that charges the provider.
2. **Asynchronous provider webhooks** (`payment.succeeded`, `payment.failed`, `payment.refunded`). These can arrive **late, twice, out of order, or forged**.

The hard part is not the CRUD. It is proving that three things always agree, whatever order and however many times those inputs arrive:

- what the **API** says the subscription is,
- what the **database** says happened (subscription, billing attempts, webhook events, audit log),
- what was actually **sent to the payment provider** (how many charges, for what amount, with which idempotency key).

So the suite is organised around **invariants that are checked after every test**, not just around endpoint responses.

---

## 2. System under test: Option 3 (hybrid)

| Component | Real or double | Why |
|---|---|---|
| HTTP service (Express) | **Real** fixture | Specs go through real routing, body parsing and error mapping via Supertest. |
| Transition table / state machine | **Real** | Core logic under test. |
| Persistence (better-sqlite3, in-memory) | **Real** | Real SQL, CHECK constraints, UNIQUE `event_id` and `idempotency_key`, and a status-guard trigger. Fresh DB per test. |
| Payment provider (outbound) | **Test double**: `MockPaymentProvider` | Implements the production `PaymentProvider` interface. Scripted success / decline / timeout (optionally "timed out but did charge"). Records every call. Idempotent on key, like a real provider. |
| Webhook delivery (inbound) | **Simulated**: `WebhookSimulator` + `WebhookEventBuilder` | The suite signs payloads itself (HMAC-SHA256) and also produces unsigned, forged, wrong-secret, tampered and malformed ones. |
| Clock | **Test double**: `FakeClock` | Trial end and retries happen when the test says so, never by sleeping. |
| Notifications | **Test double**: `RecordingNotifier` | Proves side effects fire exactly once per real transition. |
| ID generation | **Test double**: `SequentialIds` | `sub_0001`, `inv_0002`: readable failure messages. |

The fixture is deliberately small. It exists so the tests have something honest to verify.

---

## 3. Domain assumptions

**Plans** (Strategy objects, not `if (plan === 'pro')` branches):

| Plan | Price (minor units) | Trial | Period | On create |
|---|---|---|---|---|
| `basic` | 1900 USD | 14 days | 30 days | `trialing`, first charge when the trial ends |
| `pro` | 4900 USD | 0 days | 30 days | Charged inside the create request |

A zero-length trial still goes `trialing → active/past_due`. There is no "created → active" shortcut outside the transition table. The audit log for a `pro` subscription therefore reads `trialing, active`.

**Billing attempts.** One `invoices` row = one billing attempt, with `attempt` = 1..n inside a billing cycle and its own `idempotency_key` (`charge_<invoice id>`).

**Charge outcomes.**
- `succeeded` → attempt `paid`. `trialing/past_due → active`. An `active` renewal keeps its status and rolls the period forward (audited as `renewed`).
- `declined` → attempt `failed` with a failure code. `trialing/active → past_due`. A retry is scheduled one day later.
- `timeout` → **outcome unknown**. The attempt stays `pending`, the status does not change and no notification fires. The next billing run **re-sends the same attempt with the same idempotency key**, or a webhook settles it first. Marking a timeout as a failure would risk a double charge, because the provider may have charged the customer.
- While an attempt is `pending`, no **new** attempt is started for that subscription.

**Retries.** 3 retries after the first failed attempt, so 4 attempts in total. If the last one fails: `past_due → canceled` (`retries_exhausted`).

**Cancel.** Only from `trialing` or `active`, as in the diagram. `past_due` → 409 `illegal_transition`. Already canceled → 409 `subscription_already_canceled`. Cancel **voids** any pending attempt so it can never settle later.

**Refunds.** `payment.refunded` marks a `paid` attempt `refunded` and writes an audit entry, but causes **no lifecycle transition** (the diagram defines none). This is isolated in `PaymentOutcomeProcessor.applyRefund` if the intended rule differs.

**Webhook rules** (in order): valid signature over the raw body → well-formed JSON → supported type → unseen `event_id` → invoice exists, belongs to the subscription, and amount/currency match → business rules. A settled attempt is never changed again, and a canceled subscription never changes again. Anything rejected before the dedupe step leaves no trace. Anything ignored after it is stored with its outcome.

**Duplicate client requests.** `POST /subscriptions` accepts an optional `Idempotency-Key`. A retry with the same key and body replays the original response. The same key with a different body gets 422. A rejected request releases the key.

---

## 4. Test levels covered

| Level | What is proven |
|---|---|
| **Unit** | The transition table is exactly the diagram. All 9 illegal (status, trigger) pairs throw. Plan strategies. HMAC verification. |
| **API contract** | Status codes, full payload shape, error bodies, validation (missing / wrong-typed fields, unknown plan / customer / payment method, expired or foreign payment method), cancel rules, Idempotency-Key. Webhook **transport** (signature, malformed body, unsupported type, bad references, amount mismatch) is tested separately from webhook business logic. |
| **State machine** | Every row of the transition table via every driver that can cause it (API, billing run, webhook). Table-driven, with a meta-test that fails if a transition has no scenario. Invalid transitions proven impossible via API, webhook, billing run and raw SQL. |
| **Persistence** | Subscription row, billing attempts, webhook events and audit trail checked at **each stage** of a 6-step lifecycle. DB-level guards tested directly. |
| **Provider interaction** | Exact arguments, one call per attempt, same key on re-send, provider-side idempotency, and zero calls for GET / cancel / rejected create / replayed webhook. |
| **End-to-end** | Messy journeys: decline at signup → retry → cancel → stray and duplicate webhooks; dunning where every outcome arrives by (redelivered) webhook; two customers progressing side by side. |
| **Framework self-test** | `InvariantChecker` is shown to flag deliberately corrupted state, so its silence means something. |

---

## 5. Design patterns: where and why

| Pattern | Where | Problem it solves here |
|---|---|---|
| **Explicit transition table** (state machine) | `src/domain/SubscriptionStateMachine.ts` | `status` changes in one method only: `SubscriptionRepository.transition()`, which asks the table and writes the audit entry. Billing, webhooks and cancel cannot mutate `status` any other way (`updateSchedule` cannot touch it). The **same table** generates a SQLite trigger that rejects illegal status updates, and drives the table-driven lifecycle spec and its coverage meta-test. |
| **Strategy** (plan rules) | `src/domain/plans/PlanPolicy.ts` | Price, trial and period length live in one object per plan, used at creation *and* at every billing attempt. This is the "applied consistently between creation and billing" invariant, and `InvariantChecker` I6 checks it. |
| **Strategy / DI seam** (payment provider) | `PaymentProvider` in `src/ports.ts`, injected via `createApp(deps)` | The service can only charge through this interface. Tests inject `MockPaymentProvider`; nothing in `src/` knows it is a mock. The same seam is used for `Clock` and `Notifier`. |
| **Repository** | `src/persistence/repositories.ts` | All SQL lives in one file. Services write through repositories; the verification layer reads through the same classes. Specs never contain SQL, apart from the two safety-net specs. |
| **Builder** | `tests/support/builders/*` | Scenarios read as intent: `aWebhook().paymentFailed('insufficient_funds').forInvoice(inv)`. The webhook builder also owns delivery variants (`.unsigned()`, `.withForgedSignature()`, `.withTamperedBody()`, `.withRawBody()`), so transport tests are one line per case. |
| **Factory** | `tests/support/fixtures/TestEnvironment.create()` | One call wires a fresh DB, doubles, app, API client, simulator, verifiers and invariant checker, so every test starts isolated and identical. |

Not a named pattern, but important: `PaymentOutcomeProcessor` is the **single place** where a charge outcome is applied, whether it came from the provider's synchronous response or from a webhook. That is why "late webhook confirms a charge the billing run already recorded" and "stray webhook after cancel" behave identically, whichever path saw the outcome first.

---

## 6. Framework architecture

```
tests/support/
  fixtures/   TestEnvironment (Factory), useTestEnvironment (per-test lifecycle), ScenarioSteps ("given" states)
  clients/    SubscriptionApiClient     typed HTTP; all transport details
  doubles/    MockPaymentProvider, WebhookSimulator, FakeClock, RecordingNotifier, SequentialIds
  builders/   CustomerBuilder, SubscriptionRequestBuilder, WebhookEventBuilder
  verify/     SubscriptionVerifier (API vs DB vs audit), ProviderVerifier (calls/args), InvariantChecker
tests/specs/  api / lifecycle / webhooks / provider / persistence / e2e / unit / framework
```

Rules the code follows, and ESLint enforces the first one:
- Specs never import `supertest` or `better-sqlite3`. HTTP goes through the client and persistence goes through repositories.
- Verifiers never mutate state.
- `ScenarioSteps` reaches every precondition through the public API, the billing run and signed webhooks, never by inserting rows. So preconditions are themselves legal lifecycle paths.
- Every test gets its own `TestEnvironment`, and `afterEach` runs all invariants before closing it.

---

## 7. API contracts (fixture)

| Endpoint | Success | Failures tested |
|---|---|---|
| `POST /subscriptions` (optional `Idempotency-Key`) | `201` subscription (see README) | `400 validation_error`, `404 customer_not_found`, `422 unknown_plan`, `422 invalid_payment_method`, `422 idempotency_key_reused`, `409 request_in_progress` |
| `GET /subscriptions/:id` | `200` | `404 subscription_not_found` |
| `POST /subscriptions/:id/cancel` | `200`, `status: canceled` | `404`, `409 subscription_already_canceled`, `409 illegal_transition` (past_due) |
| `POST /webhooks/payment-provider` | `200 {event_id, outcome}`, where outcome ∈ `applied`, `duplicate`, `ignored_invoice_already_settled`, `ignored_subscription_canceled` | `401 missing_signature / invalid_signature`, `400 malformed_payload`, `422 unsupported_event_type / unknown_reference / amount_mismatch` |
| `POST /internal/billing/run` *(test-only)* | `200 {results: [...]}` | n/a |

Duplicates and ignored events return `200` on purpose. A real provider retries on non-2xx, so rejecting a duplicate would only cause more redelivery.

---

## 8. Database entities checked

| Table | What is asserted |
|---|---|
| `subscriptions` | Equals the API response after every step. `canceled_at` is set iff canceled (also a CHECK constraint). Period and retry fields follow plan rules. Status changes only along the table (trigger). |
| `invoices` (billing attempts) | Amount/currency = plan price. One row per genuine attempt. `attempt` numbering. `paid_at` + `provider_charge_id` iff paid/refunded. `failure_code` iff failed. At most one `pending` per subscription. `void` after cancel. UNIQUE `idempotency_key`. |
| `webhook_events` | One row per `event_id` (PRIMARY KEY). `outcome` of the first processing is kept. `delivery_count` counts redeliveries. Rejected deliveries leave no row. |
| `subscription_audit` | `created` then one `transition` per status change (plus `renewed` / `invoice_refunded`, which never change status). A legal path through the table. Last `to_status` = current status. `source` / `source_ref` identify the API call, billing attempt or webhook event. |

**Seeding and cleanup:** a fresh in-memory DB per test. Customers are seeded through a builder; everything else goes through the API.
**Avoiding false positives from stale data:** isolated DBs, queries scoped to the subscription under test, exact-length list assertions (`expectInvoices` fails on extra rows), and positive controls next to negative assertions. "Nothing changed" is asserted by comparing full before/after snapshots of all four tables.

---

## 9. Invariants (checked by `InvariantChecker` after every test)

1. **I1** A subscription is never `active` without at least one successfully paid attempt.
2. **I2** `canceled` is terminal: no transition or renewal after it, `canceled_at` set, no pending attempt left.
3. **I3** One notification per real transition, never more. One webhook `event_id` causes at most one audit entry, and none if it was ignored.
4. **I4** Every provider call maps to a billing attempt with exactly that attempt's amount, currency, customer, payment method and key. Every attempt was sent. A key is re-sent only after a timeout.
5. **I5** `GET /subscriptions/:id` equals the persisted row.
6. **I6** Every attempt is billed at its plan's price and currency.
7. **I7** The audit log is a legal walk through the transition table that ends at the current status.
8. **I8** No contradictory records (status-specific fields, timestamp ordering, at most one pending attempt, `past_due` always has a retry scheduled).

`framework/invariant-checker.spec.ts` corrupts state on purpose and proves each class of violation is reported.

---

## 10. Webhook and idempotency strategy

- **Signature:** HMAC-SHA256 over the **raw** body (the webhook route uses `express.raw`), compared in constant time. It is checked before anything is parsed or stored. Tamper, wrong-secret, forged and missing cases each assert no DB change. A forged delivery does not "burn" its `event_id`: the genuine event with that id is still applied.
- **Duplicates:** the same `event_id` twice, five times, and four times concurrently. It is applied once, with one audit entry and one notification, no invoice or provider change, and `delivery_count` = N. A duplicate arriving after the subscription moved on (e.g. after cancel) does not replay its effect.
- **Out of order / stale:** `payment.failed` after `payment.succeeded` for the same attempt does not regress `active`. A stale success for an older failed attempt does not activate a `past_due` subscription, and the current attempt still settles correctly. A refund that arrives before its success is ignored. A late confirmation of a charge the billing run already recorded is a no-op.
- **After cancel:** `payment.succeeded` for the voided in-flight attempt → `ignored_subscription_canceled`. The subscription stays canceled and the attempt stays `void`.
- **Bonus (concurrency):** concurrent duplicates, and concurrent success/failure for different attempts of one subscription. The final state is legal and all invariants hold.

---

## 11. Coverage map to the brief

| Brief section | Specs |
|---|---|
| A: Creation & activation | `lifecycle/plan-rules`, `provider/charge-outcomes`, `api/subscriptions.contract` |
| B: Validation failures | `api/validation`, `lifecycle/invalid-transitions` |
| C: Payment failure | `provider/charge-outcomes`, `lifecycle/valid-transitions` |
| D: Webhook idempotency | `webhooks/idempotency` |
| E: State-machine invariants | `lifecycle/valid-transitions`, `lifecycle/invalid-transitions`, `webhooks/out-of-order`, `unit/state-machine`, `persistence/db-guard` |
| F: Provider interaction | `provider/charge-outcomes`, InvariantChecker I4 |
| G: Persistence & auditability | `persistence/lifecycle-persistence`, InvariantChecker |

**Valid transitions tested (all 7):** each billing-driven transition by both the billing run and a webhook, and both cancel transitions via the API.
**Invalid transitions proven impossible:** `canceled → active` (late success), `canceled → past_due` (stray failure), `canceled → canceled` (cancel twice), `past_due → canceled` via API, `past_due → active` via a stale success, `active → past_due` via failure-after-success, every illegal pair at unit level, and raw SQL `canceled → active` / `active → trialing` rejected by the DB trigger.

---

## 12. Workflow: Red, Blue, Green

To be candid: the fixture and the specs were built together in small steps, one behaviour at a time. I did not keep a strictly test-first commit for every step, so I won't present the branch history as a pure Red-Blue-Green log.

What Red is meant to guarantee is that each test can fail for the right reason. I verified that directly: 14 realistic bugs were injected into the finished service, one at a time, and each one made at least one test fail (table in the README).

The Green (refactor) steps are visible in the design:
- `ScenarioSteps` replaced copy-pasted setup.
- `SubscriptionVerifier.snapshot` replaced field-by-field "unchanged" checks.
- `PaymentOutcomeProcessor` replaced separate copies of the outcome rules in billing and webhooks.

---

## 13. Known limitations

- Webhook handling is one synchronous SQLite transaction in one Node process, so concurrent deliveries are serialised. The concurrency tests prove the observable contract, not DB-level locking.
- A charge that succeeds at the provider after the customer canceled is recorded and ignored, but not auto-refunded.
- The provider's API shape is assumed. There is no contract test against the real provider.
- No proration, plan changes, taxes or multi-currency (non-goals).
- The mutation check was manual. Stryker in CI would make it continuous.

---

## 14. AI usage

See the PR description ("Responsible AI Usage").

---

## 15. What changed from the first draft of this document

- Outcome names were made more specific: `ignored_stale` became `ignored_invoice_already_settled`, and `ignored_illegal_transition` became `ignored_subscription_canceled`.
- Added `void` as an invoice status, so cancel can neutralise an in-flight attempt.
- Added `Idempotency-Key` on create, to cover duplicate client requests as well as duplicate webhooks.
- Added the DB-level status trigger and the `InvariantChecker` self-tests.
- Clarified retries as "3 retries after the first attempt" (4 attempts in total).
