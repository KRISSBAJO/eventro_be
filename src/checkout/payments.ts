import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { config } from '../config';

export type CreatedPayment = { clientSecret: string; paymentRef: string };

export interface PaymentProvider {
  readonly name: 'stripe' | 'mock';
  createPayment(input: { orderId: string; amountCents: number; email: string; description: string }): Promise<CreatedPayment>;
  refund(paymentRef: string, amountCents: number): Promise<void>;
}

/** Local development: payments always succeed when the client calls POST /orders/:id/pay. */
class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  async createPayment(input: { orderId: string }) {
    return { clientSecret: `mock_secret_${input.orderId}`, paymentRef: `mock_${input.orderId}` };
  }
  async refund() {
    /* nothing to do */
  }
}

/** Stripe PaymentIntents. The browser confirms with Stripe.js; the webhook fulfils the order. */
class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  constructor(private readonly stripe: Stripe) {}

  async createPayment(input: { orderId: string; amountCents: number; email: string; description: string }) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: 'usd',
        receipt_email: input.email,
        description: input.description,
        metadata: { orderId: input.orderId },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: `order-${input.orderId}` },
    );
    return { clientSecret: pi.client_secret ?? '', paymentRef: pi.id };
  }

  async refund(paymentRef: string, amountCents: number) {
    await this.stripe.refunds.create({ payment_intent: paymentRef, amount: amountCents });
  }
}

@Injectable()
export class Payments {
  private readonly log = new Logger('Payments');
  readonly provider: PaymentProvider;
  readonly stripe: Stripe | null;

  constructor() {
    if (config.stripeSecretKey) {
      this.stripe = new Stripe(config.stripeSecretKey);
      this.provider = new StripeProvider(this.stripe);
    } else {
      this.stripe = null;
      this.provider = new MockProvider();
      this.log.warn('STRIPE_SECRET_KEY is not set: using the mock payment provider (development only).');
    }
  }

  /** Verifies a Stripe webhook signature and returns the event. */
  parseWebhook(rawBody: Buffer, signature: string) {
    if (!this.stripe || !config.stripeWebhookSecret) throw new Error('Stripe webhooks are not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  }
}
