import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Duplicate client requests: a client that times out on POST /subscriptions will retry.
 * With the same Idempotency-Key the retry must return the original result, and must not
 * create a second subscription or charge the customer twice.
 */
describe('Duplicate create requests (Idempotency-Key)', () => {
  const t = useTestEnvironment();

  it('a retried create returns the original response and charges once', async () => {
    const { api, seedCustomer, provider, repos } = t.env;
    const customer = seedCustomer();
    const body = aSubscriptionRequest().forCustomer(customer).onPlan('pro').build();

    const first = await api.createSubscription(body, { idempotencyKey: 'idem-001' });
    const retry = await api.createSubscription(body, { idempotencyKey: 'idem-001' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(repos.subscriptions.findByCustomer(customer.customer.id)).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('without a key, two identical requests are two subscriptions (documented behaviour)', async () => {
    const { api, seedCustomer, provider, repos } = t.env;
    const customer = seedCustomer();
    const body = aSubscriptionRequest().forCustomer(customer).onPlan('pro').build();

    await api.createSubscription(body);
    await api.createSubscription(body);

    expect(repos.subscriptions.findByCustomer(customer.customer.id)).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
  });

  it('reusing a key with a different body is rejected with 422 and creates nothing new', async () => {
    const { api, seedCustomer, provider, repos } = t.env;
    const customer = seedCustomer();
    await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('pro').build(), { idempotencyKey: 'idem-002' });

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('basic').build(), {
      idempotencyKey: 'idem-002',
    });

    expect(res.status).toBe(422);
    expect(res.error?.code).toBe('idempotency_key_reused');
    expect(repos.subscriptions.findByCustomer(customer.customer.id)).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('a rejected request does not consume the key, so the corrected retry with the same key succeeds', async () => {
    const { api, seedCustomer, repos } = t.env;
    const customer = seedCustomer();
    const good = aSubscriptionRequest().forCustomer(customer).onPlan('pro').build();

    const rejected = await api.createSubscription({ ...good, plan: 'enterprise' }, { idempotencyKey: 'idem-003' });
    const corrected = await api.createSubscription(good, { idempotencyKey: 'idem-003' });

    expect(rejected.status).toBe(422);
    expect(corrected.status).toBe(201);
    expect(corrected.headers['idempotent-replayed']).toBeUndefined();
    expect(repos.subscriptions.findByCustomer(customer.customer.id)).toHaveLength(1);
  });

  it('bonus: concurrent requests with the same key create exactly one subscription', async () => {
    const { api, seedCustomer, provider, repos } = t.env;
    const customer = seedCustomer();
    const body = aSubscriptionRequest().forCustomer(customer).onPlan('pro').build();

    const responses = await Promise.all([1, 2, 3].map(() => api.createSubscription(body, { idempotencyKey: 'idem-005' })));

    expect(repos.subscriptions.findByCustomer(customer.customer.id)).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    statuses.filter((s) => s !== 201).forEach((s) => expect(s).toBe(409));
  });
});
