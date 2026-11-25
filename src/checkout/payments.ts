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

export type PaymentInput = {
  orderId: string;
  amountCents: number;
  currency: Currency;
  email: string;
  description: string;
  /** Paystack only: send the organizer's share straight to their subaccount; Eventro keeps `platformCents`. */
  split?: { subaccount: string; platformCents: number };
  /** Paystack only: 'app' sends the fan back to the website's return page with `&app=1`, which hands over to the app. */
  returnTo?: 'app';
};

/* ---------- payout banks (Paystack subaccounts) ---------- */

export type PayoutBank = { code: string; name: string; type: string };
export type SubaccountInput = { businessName: string; bankCode: string; accountNumber: string; email: string; percentageCharge: number; schedule: 'auto' | 'weekly' };

/** Bank lists, account-name checks and subaccounts. Paystack in real life; a stand-in for local development. */
export interface PayoutBanks {
  readonly live: boolean;
  banks(country: string, currency: string): Promise<PayoutBank[]>;
  resolve(accountNumber: string, bankCode: string): Promise<{ accountName: string }>;
  createSubaccount(input: SubaccountInput): Promise<{ code: string }>;
  updateSubaccount(code: string, input: Partial<SubaccountInput>): Promise<void>;
}

/** Development only (no PAYSTACK_SECRET_KEY): a few real bank codes, and any account number resolves to a test name. */
class MockPayoutBanks implements PayoutBanks {
  readonly live = false;
  private static readonly BANKS: Record<string, PayoutBank[]> = {
    NGN: [
      { code: '044', name: 'Access Bank', type: 'nuban' },
      { code: '058', name: 'Guaranty Trust Bank', type: 'nuban' },
      { code: '057', name: 'Zenith Bank', type: 'nuban' },
      { code: '011', name: 'First Bank of Nigeria', type: 'nuban' },
      { code: '033', name: 'United Bank For Africa', type: 'nuban' },
      { code: '50211', name: 'Kuda Bank', type: 'nuban' },
      { code: '999992', name: 'OPay Digital Services Limited (OPay)', type: 'nuban' },
      { code: '50515', name: 'Moniepoint MFB', type: 'nuban' },
    ],
    GHS: [
      { code: '280100', name: 'Access Bank Ghana', type: 'ghipss' },
      { code: '230100', name: 'GCB Bank', type: 'ghipss' },
      { code: 'MTN', name: 'MTN Mobile Money', type: 'mobile_money' },
    ],
    KES: [
      { code: '01', name: 'Kenya Commercial Bank', type: 'kepss' },
      { code: '68', name: 'Equity Bank', type: 'kepss' },
      { code: 'MPESA', name: 'M-PESA', type: 'mobile_money' },
    ],
    ZAR: [
      { code: '632005', name: 'Absa Bank', type: 'basa' },
      { code: '250655', name: 'First National Bank', type: 'basa' },
    ],
  };
  async banks(_country: string, currency: string) {
    return MockPayoutBanks.BANKS[currency] ?? [];
  }
  async resolve(accountNumber: string) {
    // "0000000000" stands in for an account that doesn't exist.
    if (/^0+$/.test(accountNumber)) throw new BadRequestException('Could not resolve account name. Check parameters or try again.');
    return { accountName: 'TEST ACCOUNT HOLDER' };
  }
  async createSubaccount() {
    return { code: `ACCT_test${Math.random().toString(36).slice(2, 12)}` };
  }
  async updateSubaccount() {
    /* nothing to do */
  }
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createPayment(input: PaymentInput): Promise<CreatedPayment>;
  /** `key` makes a retried refund a no-op at the provider where it supports that (Stripe), e.g. a guarantee retry. */
  refund(paymentRef: string, amountCents: number, key?: string): Promise<void>;
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

  async refund(paymentRef: string, amountCents: number, key?: string) {
    await this.stripe.refunds.create({ payment_intent: paymentRef, amount: amountCents }, key ? { idempotencyKey: key } : undefined);
  }
}

export type PaystackVerify = { status: string; amount: number; currency: string; reference: string };

/**
 * Paystack (Nigeria, Ghana, Kenya, South Africa). The fan pays on Paystack's page and comes back to the website,
 * which asks us to verify; the charge.success webhook does the same, so whichever arrives first fulfils the order.
 * Amounts are in minor units (kobo for NGN), like everything else here. The order id is the transaction reference.
 */
export class PaystackProvider implements PaymentProvider, PayoutBanks {
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
        callback_url: `${config.webUrl}/checkout/return?order=${encodeURIComponent(input.orderId)}${input.returnTo === 'app' ? '&app=1' : ''}`,
        metadata: { orderId: input.orderId, description: input.description },
        // Split: the organizer's share settles to their subaccount; Eventro keeps a flat charge and pays Paystack's fee.
        ...(input.split ? { subaccount: input.split.subaccount, transaction_charge: input.split.platformCents, bearer: 'account' } : {}),
      }),
    });
    return { paymentRef: data.reference, redirectUrl: data.authorization_url };
  }

  /* payout banks */

  readonly live = true;

  async banks(country: string, currency: string): Promise<PayoutBank[]> {
    const rows = await this.call<{ code: string; name: string; type: string; active: boolean; is_deleted?: boolean }[]>(
      `/bank?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(currency)}&perPage=500`,
    );
    return rows.filter((b) => b.active && !b.is_deleted).map((b) => ({ code: b.code, name: b.name, type: b.type }));
  }

  async resolve(accountNumber: string, bankCode: string) {
    const d = await this.call<{ account_name: string }>(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    return { accountName: d.account_name };
  }

  async createSubaccount(i: SubaccountInput) {
    const d = await this.call<{ subaccount_code: string }>('/subaccount', {
      method: 'POST',
      body: JSON.stringify({
        business_name: i.businessName,
        settlement_bank: i.bankCode,
        account_number: i.accountNumber,
        percentage_charge: i.percentageCharge,
        primary_contact_email: i.email,
        settlement_schedule: i.schedule,
      }),
    });
    return { code: d.subaccount_code };
  }

  async updateSubaccount(code: string, i: Partial<SubaccountInput>) {
    await this.call(`/subaccount/${encodeURIComponent(code)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(i.businessName ? { business_name: i.businessName } : {}),
        ...(i.bankCode ? { settlement_bank: i.bankCode } : {}),
        ...(i.accountNumber ? { account_number: i.accountNumber } : {}),
        ...(i.email ? { primary_contact_email: i.email } : {}),
        ...(i.schedule ? { settlement_schedule: i.schedule } : {}),
      }),
    });
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
    if (config.isProduction && (!this.stripe || !this.paystack)) {
      const missing = [!this.stripe && 'STRIPE_SECRET_KEY', !this.paystack && 'PAYSTACK_SECRET_KEY'].filter(Boolean).join(' and ');
      this.log.error(`Production without ${missing}: those currencies can’t be sold (test payments are off in production).`);
    }
  }

  /** Bank lists, name checks and subaccounts for Paystack payouts (a stand-in outside production without a key). */
  payoutBanks(): PayoutBanks | null {
    if (this.paystack) return this.paystack;
    return config.isProduction ? null : this.mockBanks;
  }
  private readonly mockBanks = new MockPayoutBanks();

  /** Which provider charges this currency. */
  forCurrency(currency: Currency): PaymentProvider {
    const real = PAYSTACK_CURRENCIES.has(currency) ? this.paystack : this.stripeProvider;
    if (real) return real;
    // Never fall back to free test payments on a live site.
    if (config.isProduction) throw new ServiceUnavailableException(`Payments in ${currency} aren’t available right now. Please try again later.`);
    return this.mock;
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
