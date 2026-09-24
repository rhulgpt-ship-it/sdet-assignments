import { aCustomer } from '../../support/builders/CustomerBuilder';
import { aSubscriptionRequest } from '../../support/builders/SubscriptionRequestBuilder';
import { useTestEnvironment } from '../../support/fixtures/useTestEnvironment';

/**
 * Rejected requests: right status + error code, and — just as important — no subscription row,
 * no invoice, no audit entry and no call to the payment provider.
 */
describe('API validation failures on POST /subscriptions', () => {
  const t = useTestEnvironment();

  const expectNothingHappened = (customerId: string) => {
    t.env.verify.expectNoSubscriptionsFor(customerId);
    expect(t.env.repos.invoices.findAll()).toEqual([]);
    t.env.providerVerify.expectNoCharges();
    expect(t.env.notifier.sent).toEqual([]);
  };

  it.each([
    ['customer_id missing', (b: ReturnType<typeof aSubscriptionRequest>) => b.without('customer_id'), 'customer_id is required'],
    ['plan missing', (b: ReturnType<typeof aSubscriptionRequest>) => b.without('plan'), 'plan is required'],
    ['payment_method_id missing', (b: ReturnType<typeof aSubscriptionRequest>) => b.without('payment_method_id'), 'payment_method_id is required'],
    ['plan is a number', (b: ReturnType<typeof aSubscriptionRequest>) => b.with('plan', 42), 'plan must be a non-empty string'],
    ['customer_id is blank', (b: ReturnType<typeof aSubscriptionRequest>) => b.with('customer_id', '  '), 'customer_id must be a non-empty string'],
  ])('400 validation_error when %s', async (_label, mutate, detail) => {
    const { api, seedCustomer } = t.env;
    const customer = seedCustomer();

    const res = await api.createSubscription(mutate(aSubscriptionRequest().forCustomer(customer).onPlan('pro')).build());

    expect(res.status).toBe(400);
    expect(res.error).toMatchObject({ code: 'validation_error', details: expect.arrayContaining([detail]) });
    expectNothingHappened(customer.customer.id);
  });

  it('400 when the body is not valid JSON', async () => {
    const res = await t.env.api.createSubscriptionRaw('{"customer_id": "cust_1", ');
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('validation_error');
    t.env.providerVerify.expectNoCharges();
  });

  it('400 when the body is a JSON array instead of an object', async () => {
    const res = await t.env.api.createSubscription([{ plan: 'pro' }]);
    expect(res.status).toBe(400);
    expect(res.error?.details).toEqual(['body must be a JSON object']);
  });

  it('422 unknown_plan for a plan that does not exist', async () => {
    const { api, seedCustomer } = t.env;
    const customer = seedCustomer();

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).onPlan('enterprise').build());

    expect(res.status).toBe(422);
    expect(res.error?.code).toBe('unknown_plan');
    expectNothingHappened(customer.customer.id);
  });

  it('404 customer_not_found for an unknown customer', async () => {
    const res = await t.env.api.createSubscription(
      aSubscriptionRequest().withCustomerId('cust_ghost').withPaymentMethod('pm_ghost').onPlan('pro').build(),
    );
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe('customer_not_found');
    expectNothingHappened('cust_ghost');
  });

  it('422 invalid_payment_method when the payment method does not exist', async () => {
    const { api, seedCustomer } = t.env;
    const customer = seedCustomer();

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).withPaymentMethod('pm_missing').onPlan('pro').build());

    expect(res.status).toBe(422);
    expect(res.error?.code).toBe('invalid_payment_method');
    expectNothingHappened(customer.customer.id);
  });

  it("422 invalid_payment_method when the payment method belongs to someone else", async () => {
    const { api, seedCustomer } = t.env;
    const alice = seedCustomer(aCustomer().withPaymentMethod('pm_alice_visa'));
    const bob = seedCustomer();

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(bob).withPaymentMethod('pm_alice_visa').onPlan('pro').build());

    expect(res.status).toBe(422);
    expect(res.error?.code).toBe('invalid_payment_method');
    expectNothingHappened(bob.customer.id);
    expectNothingHappened(alice.customer.id);
  });

  it('422 invalid_payment_method when the payment method is expired', async () => {
    const { api, seedCustomer } = t.env;
    const customer = seedCustomer(aCustomer().withExpiredPaymentMethod('pm_expired'));

    const res = await api.createSubscription(aSubscriptionRequest().forCustomer(customer).withPaymentMethod('pm_expired').onPlan('pro').build());

    expect(res.status).toBe(422);
    expectNothingHappened(customer.customer.id);
  });
});
