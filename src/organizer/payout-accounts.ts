/**
 * Where an organization's money goes.
 *
 * The payout country decides the provider:
 *   - Nigeria, Ghana, Kenya and South Africa → a Paystack subaccount. The organizer picks their bank, types the account
 *     number, and Paystack tells us the account holder's name so they can confirm it's the right account. The number
 *     goes straight to Paystack; we keep only the bank, the last 4 digits and the holder's name. On each sale Paystack
 *     splits the payment: the organizer's share settles to their bank, Omoshow keeps its fee.
 *   - Everywhere else → Stripe Connect (Stripe's hosted onboarding page; see OrganizerService.payoutOnboarding).
 *
 * Changing the account is guarded: org admins only, the name check must pass, every admin on the team is emailed, and
 * payouts pause for 24 hours (sales in that window are collected by Omoshow and paid out after).
 *
 *   GET  /organizer/payout-countries
 *   GET  /organizer/orgs/:orgId/payouts/banks?country=NG
 *   POST /organizer/orgs/:orgId/payouts/resolve      { country, bankCode, accountNumber } → { accountName }
 *   PUT  /organizer/orgs/:orgId/payouts/bank         { country, bankCode, accountNumber }
 */
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { Payments, type PayoutBank } from '../checkout/payments';
import { MailService, render } from '../mail/mail.module';
import { config } from '../config';
import type { AuthUser } from '../common/auth';

export type PayoutCountry = { code: string; name: string; currency: string; provider: 'paystack' | 'stripe'; paystackName?: string; mobileMoney?: boolean };

export const PAYOUT_COUNTRIES: PayoutCountry[] = [
  { code: 'NG', name: 'Nigeria', currency: 'NGN', provider: 'paystack', paystackName: 'nigeria' },
  { code: 'GH', name: 'Ghana', currency: 'GHS', provider: 'paystack', paystackName: 'ghana', mobileMoney: true },
  { code: 'KE', name: 'Kenya', currency: 'KES', provider: 'paystack', paystackName: 'kenya', mobileMoney: true },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR', provider: 'paystack', paystackName: 'south africa' },
  { code: 'US', name: 'United States', currency: 'USD', provider: 'stripe' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', provider: 'stripe' },
  { code: 'CA', name: 'Canada', currency: 'CAD', provider: 'stripe' },
  { code: 'IE', name: 'Ireland', currency: 'EUR', provider: 'stripe' },
  { code: 'DE', name: 'Germany', currency: 'EUR', provider: 'stripe' },
  { code: 'FR', name: 'France', currency: 'EUR', provider: 'stripe' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR', provider: 'stripe' },
  { code: 'ES', name: 'Spain', currency: 'EUR', provider: 'stripe' },
  { code: 'IT', name: 'Italy', currency: 'EUR', provider: 'stripe' },
  { code: 'AU', name: 'Australia', currency: 'AUD', provider: 'stripe' },
];
const PAYSTACK_CODES = PAYOUT_COUNTRIES.filter((c) => c.provider === 'paystack').map((c) => c.code);
export const paystackCountryFor = (currency: string) => PAYOUT_COUNTRIES.find((c) => c.provider === 'paystack' && c.currency === currency);

export class BankAccountDto {
  @ApiProperty({ enum: PAYSTACK_CODES }) @IsIn(PAYSTACK_CODES) country: string;
  @ApiProperty() @IsString() @MaxLength(20) @Matches(/^[A-Za-z0-9]+$/) bankCode: string;
  @ApiProperty({ description: 'NUBAN (10 digits) in Nigeria; account or mobile money number elsewhere' })
  @IsString()
  @Matches(/^\d{6,20}$/, { message: 'Enter the account number using digits only.' })
  accountNumber: string;
}

const HOLD_MS = 24 * 60 * 60 * 1000;
const BANK_TTL = 6 * 60 * 60 * 1000;
/** Name checks per organization per 10 minutes (stops someone using us to look up strangers' accounts). */
const RESOLVE_LIMIT = 12;

@Injectable()
export class PayoutAccounts {
  private readonly bankCache = new Map<string, { at: number; banks: PayoutBank[] }>();
  private readonly lookups = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: Payments,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  countries() {
    const live = this.payments.payoutBanks()?.live ?? false;
    return { countries: PAYOUT_COUNTRIES.map(({ paystackName: _n, ...c }) => c), paystackLive: live, stripeLive: !!this.payments.stripe };
  }

  private async admin(orgId: string, user: AuthUser) {
    const m = await this.prisma.organizationMember.findFirst({ where: { orgId, status: 'ACTIVE', role: 'ADMIN', OR: [{ userId: user.id }, { email: user.email }] } });
    if (!m) throw new ForbiddenException('Only admins of this organization can manage payouts.');
  }

  private provider() {
    const p = this.payments.payoutBanks();
    if (!p) throw new ServiceUnavailableException('Bank payouts aren’t set up on this server yet (PAYSTACK_SECRET_KEY).');
    return p;
  }

  private country(code: string) {
    const c = PAYOUT_COUNTRIES.find((x) => x.code === code && x.provider === 'paystack');
    if (!c) throw new BadRequestException('Pick Nigeria, Ghana, Kenya or South Africa for bank payouts.');
    return c;
  }

  async banks(orgId: string, user: AuthUser, code: string) {
    await this.admin(orgId, user);
    const c = this.country(code);
    const hit = this.bankCache.get(c.code);
    if (hit && Date.now() - hit.at < BANK_TTL) return { country: c.code, currency: c.currency, banks: hit.banks };
    const banks = (await this.provider().banks(c.paystackName!, c.currency)).sort((a, b) => a.name.localeCompare(b.name));
    this.bankCache.set(c.code, { at: Date.now(), banks });
    return { country: c.code, currency: c.currency, banks };
  }

  private async bankName(code: string, bankCode: string) {
    const c = this.country(code);
    const hit = this.bankCache.get(c.code)?.banks ?? (await this.provider().banks(c.paystackName!, c.currency));
    const b = hit.find((x) => x.code === bankCode);
    if (!b) throw new BadRequestException('Pick your bank from the list.');
    return b;
  }

  private limit(orgId: string) {
    const now = Date.now();
    const recent = (this.lookups.get(orgId) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= RESOLVE_LIMIT) throw new BadRequestException('Too many account checks. Please wait a few minutes and try again.');
    recent.push(now);
    this.lookups.set(orgId, recent);
  }

  /** The account holder's name, so the organizer can see it's the right account before saving. */
  async resolve(orgId: string, user: AuthUser, dto: BankAccountDto) {
    await this.admin(orgId, user);
    const bank = await this.bankName(dto.country, dto.bankCode);
    this.limit(orgId);
    const { accountName } = await this.provider()
      .resolve(dto.accountNumber, dto.bankCode)
      .catch(() => {
        throw new BadRequestException('We couldn’t find that account. Check the bank and the account number.');
      });
    return { accountName, bankName: bank.name, last4: dto.accountNumber.slice(-4) };
  }

  /** Saves the payout account: checks the name again on the server, then creates or updates the Paystack subaccount. */
  async save(orgId: string, user: AuthUser, dto: BankAccountDto) {
    await this.admin(orgId, user);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const bank = await this.bankName(dto.country, dto.bankCode);
    this.limit(orgId);
    const p = this.provider();
    const { accountName } = await p.resolve(dto.accountNumber, dto.bankCode).catch(() => {
      throw new BadRequestException('We couldn’t find that account. Check the bank and the account number.');
    });
    const sub = {
      businessName: org.name,
      bankCode: dto.bankCode,
      accountNumber: dto.accountNumber,
      email: org.supportEmail,
      percentageCharge: config.organizerFeePermille / 10,
      schedule: org.payoutSchedule === 'WEEKLY' ? ('weekly' as const) : ('auto' as const),
    };
    let code = org.payoutProvider === 'paystack' ? org.paystackSubaccount : null;
    if (code) await p.updateSubaccount(code, sub);
    else code = (await p.createSubaccount(sub)).code;

    const changing = !!(org.bankLast4 || org.stripeAccountId || org.paystackSubaccount);
    const last4 = dto.accountNumber.slice(-4);
    const holdUntil = changing ? new Date(Date.now() + HOLD_MS) : null;
    await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        payoutProvider: 'paystack',
        paystackSubaccount: code,
        bankCode: dto.bankCode,
        bankName: bank.name,
        bankLast4: last4,
        bankAccountName: accountName,
        bankCountry: dto.country,
        payoutHoldUntil: holdUntil,
        payoutUpdatedAt: new Date(),
      },
    });
    await this.audit.log(user.id, changing ? 'payout.bank.change' : 'payout.bank.add', 'Organization', orgId, { bank: bank.name, last4, country: dto.country });
    await this.notifyAdmins(orgId, org.name, user, { bank: bank.name, last4, accountName, changing, holdUntil });
    return { bankName: bank.name, bankLast4: last4, accountName, country: dto.country, holdUntil };
  }

  /** Paystack's settlement schedule follows the organizer's choice (daily → next business day, weekly → Mondays). */
  async syncSchedule(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (org?.payoutProvider !== 'paystack' || !org.paystackSubaccount) return;
    await this.payments
      .payoutBanks()
      ?.updateSubaccount(org.paystackSubaccount, { schedule: org.payoutSchedule === 'WEEKLY' ? 'weekly' : 'auto' })
      .catch(() => undefined);
  }

  private async notifyAdmins(
    orgId: string,
    orgName: string,
    by: AuthUser,
    a: { bank: string; last4: string; accountName: string; changing: boolean; holdUntil: Date | null },
  ) {
    const admins = await this.prisma.organizationMember.findMany({ where: { orgId, status: 'ACTIVE', role: 'ADMIN' }, select: { email: true } });
    const to = [...new Set(admins.map((m) => m.email.toLowerCase()))];
    const when = a.holdUntil?.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    const { html, text } = render({
      preheader: `${by.name} ${a.changing ? 'changed' : 'added'} the payout account for ${orgName}.`,
      heading: a.changing ? 'Your payout account was changed' : 'Payout account added',
      paragraphs: [
        `${by.name} (${by.email}) ${a.changing ? 'changed' : 'added'} the bank account ${orgName} gets paid into:`,
        `${a.bank} ···· ${a.last4} — ${a.accountName}`,
        ...(a.changing && when ? [`To keep you safe, payouts are paused until ${when} UTC. Sales keep going as normal and are paid out after that.`] : []),
        'If this wasn’t your team, reply to this email right away and we’ll lock the account.',
      ],
      cta: { label: 'Review payouts', url: `${config.webUrl}/organizer/payouts` },
      footer: `You’re getting this because you’re an admin of ${orgName} on Omoshow.`,
    });
    await this.mail.sendMany('payout.bank', to.map((addr) => ({ to: addr, subject: `${a.changing ? 'Payout account changed' : 'Payout account added'}: ${a.bank} ···· ${a.last4}`, html, text }))).catch(() => undefined);
  }
}
