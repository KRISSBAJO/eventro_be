import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { config } from '../config';
import { PAYSTACK_CURRENCIES, type Currency } from '../domain/currency';

export type ProviderName = 'stripe' | 'paystack' | 'mock';

/**
 * What the browser needs to pay:
 *   stripe   → clientSecret for Stripe.js
 *   paystack → redirectUrl to Paystack's checkout page (fans come back to /checkout/return)
 *   mock     → nothing; POST /orders/:id/pay completes it (development only)
 */
export type CreatedPayment = { paymentRef: string; clientSecret?: string; redirectUrl?: string };

export type PaymentInput = { orderId: string; amountCents: number; currency: Currency; email: string; description: string };

export interface PaymentProvider {
  readonly name: ProviderName;
  createPayment(input: PaymentInput): Promise<CreatedPayment>;
  refund(paymentRef: string, amountCents: number): Promise<void>;
}

/** Local development: payments always succeed when the client calls POST /orders/:id/pay. */
class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  async createPayment(input: PaymentInput) {
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

  async createPayment(input: PaymentInput) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
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

export type PaystackVerify = { status: string; amount: number; currency: string; reference: string };

/**
 * Paystack (Nigeria, Ghana, Kenya, South Africa). The fan pays on Paystack's page and comes back to the website,
 * which asks us to verify; the charge.success webhook does the same, so whichever arrives first fulfils the order.
 * Amounts are in minor units (kobo for NGN), like everything else here. The order id is the transaction reference.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  private readonly log = new Logger('Paystack');

  constructor(private readonly secret: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${config.paystackUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (e) {
      this.log.warn(`Paystack unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Paystack isn’t reachable right now. Please try again.');
    }
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || body.status === false) throw new BadRequestException(body.message ?? `Paystack error ${res.status}`);
    return body.data as T;
  }

  async createPayment(input: PaymentInput) {
    const data = await this.call<{ authorization_url: string; reference: string }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: input.amountCents,
        currency: input.currency,
        reference: input.orderId,
        callback_url: `${config.webUrl}/checkout/return?order=${encodeURIComponent(input.orderId)}`,
        metadata: { orderId: input.orderId, description: input.description },
      }),
    });
    return { paymentRef: data.reference, redirectUrl: data.authorization_url };
  }

  /** The transaction as Paystack sees it. */
  verify(reference: string) {
    return this.call<PaystackVerify>(`/transaction/verify/${encodeURIComponent(reference)}`);
  }

  async refund(paymentRef: string, amountCents: number) {
    await this.call('/refund', { method: 'POST', body: JSON.stringify({ transaction: paymentRef, amount: amountCents }) });
  }

  /** Paystack signs webhooks with HMAC-SHA512 of the raw body, keyed with the secret key. */
  signatureOk(rawBody: Buffer, signature: string) {
    const expected = createHmac('sha512', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

@Injectable()
export class Payments {
  private readonly log = new Logger('Payments');
  readonly stripe: Stripe | null;
  readonly paystack: PaystackProvider | null;
  private readonly mock = new MockProvider();
  private readonly stripeProvider: StripeProvider | null;

  constructor() {
    this.stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
    this.stripeProvider = this.stripe ? new StripeProvider(this.stripe) : null;
    this.paystack = config.paystackSecretKey ? new PaystackProvider(config.paystackSecretKey) : null;
    if (!this.stripe) this.log.warn('STRIPE_SECRET_KEY is not set: card payments outside Paystack use the mock provider (development only).');
    if (!this.paystack) this.log.warn('PAYSTACK_SECRET_KEY is not set: NGN, GHS, KES and ZAR payments use the mock provider (development only).');
  }

  /** Which provider charges this currency. */
  forCurrency(currency: Currency): PaymentProvider {
    if (PAYSTACK_CURRENCIES.has(currency)) return this.paystack ?? this.mock;
    return this.stripeProvider ?? this.mock;
  }

  /** The provider an existing order was paid with (for refunds). */
  byName(name: string): PaymentProvider {
    if (name === 'paystack' && this.paystack) return this.paystack;
    if (name === 'stripe' && this.stripeProvider) return this.stripeProvider;
    return this.mock;
  }

  /** For /health: which providers are live. */
  summary() {
    return { stripe: !!this.stripe, paystack: !!this.paystack };
  }

  /** Verifies a Stripe webhook signature and returns the event. */
  parseWebhook(rawBody: Buffer, signature: string) {
    if (!this.stripe || !config.stripeWebhookSecret) throw new Error('Stripe webhooks are not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  }
}
