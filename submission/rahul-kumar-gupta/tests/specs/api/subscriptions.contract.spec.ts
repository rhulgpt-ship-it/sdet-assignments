import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Response codes and payload shape for create / get / cancel, and API-vs-DB agreement. */
describe('API contract: /subscriptions', () => {
  const t = useTestEnvironment();

  it('POST /subscriptions returns 201 with the full subscription shape', async () => {
    const { api, seedCustomer, verify } = t.env;
    const customer = seedCustomer();

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('basic').build());

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^sub_/),
      customer_id: customer.customer.id,
      plan: 'basic',
      status: 'trialing',
      payment_method_id: customer.defaultPaymentMethodId,
      trial_ends_at: expect.stringMatching(ISO),
      current_period_start: null,
      current_period_end: null,
      next_retry_at: null,
      canceled_at: null,
      created_at: expect.stringMatching(ISO),
      updated_at: expect.stringMatching(ISO),
      latest_invoice: null,
    });
    await verify.expectApiMatchesDatabase(res.body.id);
  });

  it('GET /subscriptions/:id returns exactly what POST returned', async () => {
    const { api, seedCustomer } = t.env;
    const created = await api.createSubscription(aSubscriptionRequest().forCustomer(seedCustomer()).onPlan('pro').build());

    const fetched = await api.getSubscription(created.body.id);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
  });

  it('GET /subscriptions/:id returns 404 with an error body for an unknown id', async () => {
    const res = await t.env.api.getSubscription('sub_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.error).toEqual({ code: 'subscription_not_found', message: expect.any(String) });
  });

  it('POST /subscriptions/:id/cancel returns 200 with status canceled and canceled_at set', async () => {
    const { api, given, clock, verify } = t.env;
    const g = await given.active();
    clock.advanceDays(3);

    const res = await api.cancelSubscription(g.subscription.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: g.subscription.id, status: 'canceled', canceled_at: clock.now().toISOString() });
    await verify.expectApiMatchesDatabase(g.subscription.id);
  });

  it('POST /subscriptions/:id/cancel returns 404 for an unknown id', async () => {
    const res = await t.env.api.cancelSubscription('sub_nope');
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe('subscription_not_found');
  });
});
