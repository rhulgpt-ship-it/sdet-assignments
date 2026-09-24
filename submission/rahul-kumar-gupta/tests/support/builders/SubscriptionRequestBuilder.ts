import type { CustomerSeed } from './CustomerBuilder';

/**
 * aSubscriptionRequest().forCustomer(customer).onPlan('pro').build()
 * aSubscriptionRequest().forCustomer(customer).without('plan').build()
 */
export class SubscriptionRequestBuilder {
  private readonly body: Record<string, unknown> = {
    customer_id: 'cust_unset',
    plan: 'basic',
    payment_method_id: 'pm_unset',
  };

  forCustomer(seed: CustomerSeed): this {
    this.body.customer_id = seed.customer.id;
    this.body.payment_method_id = seed.defaultPaymentMethodId;
    return this;
  }

  onPlan(plan: string): this {
    this.body.plan = plan;
    return this;
  }

  withPaymentMethod(id: string): this {
    this.body.payment_method_id = id;
    return this;
  }

  withCustomerId(id: string): this {
    this.body.customer_id = id;
    return this;
  }

  with(field: string, value: unknown): this {
    this.body[field] = value;
    return this;
  }

  without(field: string): this {
    delete this.body[field];
    return this;
  }

  build(): Record<string, unknown> {
    return { ...this.body };
  }
}

export const aSubscriptionRequest = () => new SubscriptionRequestBuilder();
