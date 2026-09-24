import type { Customer, PaymentMethod } from '../../../src/domain/types';

let customerSeq = 0;

export interface CustomerSeed {
  customer: Customer;
  paymentMethods: PaymentMethod[];
  /** First valid payment method, the one most scenarios subscribe with. */
  defaultPaymentMethodId: string;
}

/** aCustomer().withPaymentMethod('pm_test_visa_4242').withExpiredPaymentMethod('pm_old').build() */
export class CustomerBuilder {
  private readonly id: string;
  private email: string;
  private readonly paymentMethods: PaymentMethod[] = [];

  constructor() {
    customerSeq += 1;
    this.id = `cust_${String(customerSeq).padStart(4, '0')}`;
    this.email = `${this.id}@example.test`;
  }

  withEmail(email: string): this {
    this.email = email;
    return this;
  }

  withPaymentMethod(id: string): this {
    this.paymentMethods.push({ id, customer_id: this.id, status: 'valid' });
    return this;
  }

  withExpiredPaymentMethod(id: string): this {
    this.paymentMethods.push({ id, customer_id: this.id, status: 'expired' });
    return this;
  }

  build(createdAt: string): CustomerSeed {
    const paymentMethods = this.paymentMethods.length
      ? this.paymentMethods
      : [{ id: `pm_${this.id}_visa`, customer_id: this.id, status: 'valid' as const }];
    const firstValid = paymentMethods.find((p) => p.status === 'valid');
    return {
      customer: { id: this.id, email: this.email, created_at: createdAt },
      paymentMethods,
      defaultPaymentMethodId: (firstValid ?? paymentMethods[0]).id,
    };
  }
}

export const aCustomer = () => new CustomerBuilder();
