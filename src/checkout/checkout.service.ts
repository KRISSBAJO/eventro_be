import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TIER_FIELDS, withLook } from '../domain/tier-look';
import { InventoryService } from '../common/inventory.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { orderCode, ticketCode } from '../domain/codes';
import { buyerPrice, organizerNet, quote } from '../domain/money';
import { FRAUD_FLAG_THRESHOLD, scoreOrder } from '../domain/fraud';
import { pickFromSections, rowLabel, type SeatMap, type SeatPick } from '../domain/seatmap';
import { Payments } from './payments';
import { FxService } from '../fx/fx.module';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { GiftService, type GiftInput } from '../gifts/gifts.module';
import { ResaleService } from '../resale/resale.module';
import { isCurrency, type Currency } from '../domain/currency';
import type { AuthUser } from '../common/auth';
import { paystackCountryFor } from '../organizer/payout-accounts';
import { NoticeService } from '../push/notices';
import { PROMO_ON_PWYW, checkDonation, donationsView, isPwyw, pwywUnit, pwywView, type DonationSettings, type PwywTier } from '../domain/pwyw';
import { seatTier, ticketDateFields, ticketDates, ticketTimes, whenText } from '../domain/event-dates';
import { releaseReservations } from '../schedule/release';

type Tx = Prisma.TransactionClient;

/** What the fan can change about the price of a hold at the quote and the order. */
export type PriceInput = { promoCode?: string; protection?: boolean; amountCents?: number; donationCents?: number };

/** Turns a rule's plain Error into a 400 for the fan. */
const fanRule = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
};

/**
 * The all-in price per ticket for a hold: the tier's price, or for pay what you want the fan's chosen base amount
 * (checked against the tier's limits) with the event's fee mode applied exactly as for a fixed price.
 */
function unitFor(tt: PwywTier & { priceCents: number }, ev: { feeMode: 'BUYER' | 'ORGANIZER'; currency: string }, amountCents: number | null | undefined) {
  if (!isPwyw(tt)) return { unitCents: tt.priceCents, amountCents: null };
  const unitCents = fanRule(() => pwywUnit(tt, amountCents, ev.feeMode, config.organizerFeePermille, ev.currency));
  return { unitCents, amountCents: amountCents! };
}

/** Omoshow's fee inside the tickets' price that the fan pays on top (BUYER mode); 0 when the organizer absorbs it. */
const buyerFee = (unitCents: number, quantity: number, feeMode: 'BUYER' | 'ORGANIZER') => (feeMode === 'BUYER' ? (unitCents - organizerNet(unitCents, 'BUYER', config.organizerFeePermille)) * quantity : 0);

/** Serializes inventory changes per ticket type (row lock for the rest of the transaction). */
const lockTicketType = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM "TicketType" WHERE id = ${id} FOR UPDATE`;

@Injectable()
export class CheckoutService {
  private readonly log = new Logger('Checkout');

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly payments: Payments,
    private readonly audit: AuditService,
    private readonly fx: FxService,
    private readonly mail: MailService,
    private readonly gifts: GiftService,
    private readonly resale: ResaleService,
    private readonly notices: NoticeService,
  ) {}

  /* ---------- holds ---------- */

  async createHold(input: { ticketTypeId: string; quantity: number; sectionId?: string; seats?: { row: string; seat: number }[]; amountCents?: number }, user: AuthUser | null) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockTicketType(tx, input.ticketTypeId);
      const tt = await tx.ticketType.findUnique({ where: { id: input.ticketTypeId }, include: { event: { include: { dates: true } } } });
      if (!tt) throw new NotFoundException('Ticket type not found.');
      const ev = tt.event;
      if (ev.status !== 'PUBLISHED') throw new BadRequestException('This event is not on sale.');
      if (ev.salesPaused) throw new ConflictException('Sales are paused by the organizer.');
      // Multiple dates: a copy of a cancelled date isn't on sale, and each date (or a pass's first day) stops on its own.
      const date = tt.eventDateId ? ev.dates.find((d) => d.id === tt.eventDateId) : null;
      if (date && date.status === 'CANCELLED') throw new BadRequestException('This date was cancelled.');
      if (ticketTimes(ev.dateMode, ev, tt, ev.dates).first.startsAt <= now) throw new BadRequestException(date ? 'This date has already started.' : 'This event has already started.');
      if ((tt.salesStart && tt.salesStart > now) || (tt.salesEnd && tt.salesEnd < now)) throw new BadRequestException('These tickets are not on sale right now.');
      if (input.quantity > tt.maxPerOrder) throw new BadRequestException(`You can buy up to ${tt.maxPerOrder} of these per order.`);
      // Pay what you want: the amount is checked here, and again at the quote and the order.
      const { amountCents } = unitFor(tt, ev, input.amountCents);

      const left = await this.inventory.availableForType(tx, tt.id, now);
      if (left < input.quantity) throw new ConflictException(left ? `Only ${left} left.` : 'Sold out.');

      if (input.sectionId) {
        const map = ev.seatMap as SeatMap | null;
        const section = map?.sections.find((s) => s.id === input.sectionId);
        if (!section || section.ticketTypeId !== seatTier(tt)) throw new BadRequestException('That section isn’t sold with this ticket type.');
        const sec = await this.inventory.availabilityForSections(tx, ev.id, { ...map!, sections: [section] }, now, tt.eventDateId);
        const n = sec.get(section.id) ?? 0;
        if (n < input.quantity) throw new ConflictException(n ? `Only ${n} left in ${section.label}.` : `${section.label} is sold out.`);
      }

      // On a seat map the hold reserves exact seats, so the group is guaranteed to sit together.
      const map = ev.seatMap as SeatMap | null;
      const sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === seatTier(tt) && (!input.sectionId || s.id === input.sectionId));
      let seats: SeatPick[] | null = null;
      if (input.seats) {
        // The fan picked exact seats: one per ticket, all in the chosen reserved section, all free right now.
        const section = input.sectionId ? sections.find((s) => s.id === input.sectionId) : undefined;
        if (!section) throw new BadRequestException('Pick a section to choose exact seats.');
        if (section.seating !== 'reserved') throw new BadRequestException(`${section.label} is standing only: there are no seat numbers to pick.`);
        if (input.seats.length !== input.quantity) throw new BadRequestException(`Pick ${input.quantity} seat${input.quantity === 1 ? '' : 's'}, one for each ticket.`);
        const rows = new Set(Array.from({ length: section.rows ?? 0 }, (_, i) => rowLabel(i)));
        const keys = input.seats.map((s) => `${s.row}:${s.seat}`);
        if (new Set(keys).size !== keys.length) throw new BadRequestException('Each seat can only be picked once.');
        if (input.seats.some((s) => !rows.has(s.row) || s.seat > (section.seatsPerRow ?? 0))) throw new BadRequestException('Some of those seats aren’t in this section.');
        const used = (await this.inventory.seatsInUse(tx, ev.id, [section.id], now, undefined, tt.eventDateId)).get(section.id);
        const gone = input.seats.filter((s) => used?.seats.has(`${s.row}:${s.seat}`));
        if (gone.length) throw new ConflictException(`${gone.map((s) => `${s.row}${s.seat}`).join(', ')} ${gone.length === 1 ? 'was' : 'were'} just taken. Pick other seats.`);
        seats = input.seats.map((s) => ({ section: section.id, row: s.row, seat: s.seat }));
      } else if (sections.length) {
        const inUse = await this.inventory.seatsInUse(tx, ev.id, sections.map((s) => s.id), now, undefined, tt.eventDateId);
        seats = pickFromSections(sections, inUse, input.quantity);
        if (!seats) throw new ConflictException('Not enough seats together. Try fewer tickets or another section.');
      }

      return tx.hold.create({
        data: {
          eventId: ev.id,
          ticketTypeId: tt.id,
          sectionId: seats?.[0]?.section ?? input.sectionId ?? null,
          ...(seats ? { seats } : {}),
          quantity: input.quantity,
          amountCents,
          userId: user?.id ?? null,
          expiresAt: new Date(now.getTime() + config.holdMinutes * 60_000),
        },
        select: { id: true, quantity: true, expiresAt: true, sectionId: true, ticketTypeId: true, seats: true, amountCents: true },
      });
    });
  }

  /** A hold with what the checkout page needs to show. The id is unguessable, so it acts as the key. */
  async getHold(id: string) {
    const h = await this.prisma.hold.findUnique({
      where: { id },
      include: {
        ticketType: { select: { id: true, description: true, priceCents: true, pricing: true, pwywMinCents: true, pwywSuggestedCents: true, pwywMaxCents: true, pwywQuickPicks: true, eventDateId: true, validDateIds: true, ...TIER_FIELDS } },
        event: {
          select: {
            dateMode: true,
            dates: true,
            slug: true,
            title: true,
            subtitle: true,
            category: true,
            currency: true,
            timezone: true,
            imageUrl: true,
            startsAt: true,
            doorsAt: true,
            description: true,
            seatMap: true,
            feeMode: true,
            donationsEnabled: true,
            donationCause: true,
            donationDescription: true,
            donationSuggestedCents: true,
            donationMinCents: true,
            venue: { select: { name: true, city: true, address: true } },
          },
        },
        order: { select: { id: true, status: true } },
      },
    });
    if (!h) throw new NotFoundException('Hold not found.');
    const { seatMap, donationsEnabled, donationCause, donationDescription, donationSuggestedCents, donationMinCents, dates, ...event } = h.event;
    const section = (seatMap as SeatMap | null)?.sections.find((s) => s.id === h.sectionId);
    const { pwywMinCents, pwywSuggestedCents, pwywMaxCents, pwywQuickPicks, eventDateId, validDateIds, ...tt } = h.ticketType;
    const pwyw = pwywView(h.ticketType, event.feeMode, config.organizerFeePermille);
    return {
      id: h.id,
      status: h.status === 'ACTIVE' && h.expiresAt <= new Date() ? 'EXPIRED' : h.status,
      quantity: h.quantity,
      expiresAt: h.expiresAt,
      section: section ? { id: section.id, label: section.label, level: section.level ?? null, seating: section.seating } : null,
      seats: (h.seats as SeatPick[] | null) ?? [],
      // Pay what you want: the base amount chosen per ticket, and what each ticket costs all-in.
      amountCents: h.amountCents,
      unitCents: pwyw && h.amountCents !== null ? buyerPrice(h.amountCents, event.feeMode, config.organizerFeePermille) : h.ticketType.priceCents,
      // The donation chosen before checkout moved here (PATCH /holds/:id); 0 = none. The quote and order use it by default.
      donationCents: h.donationCents,
      ticketType: { ...withLook(tt), pwyw, eventDateId, validDateIds },
      // The date being bought (multiple dates) or the days the tickets cover (multi-day)
      ...ticketDates(event.dateMode, h.ticketType, dates),
      event: { ...event, feePermille: config.organizerFeePermille, donations: donationsView({ donationsEnabled, donationCause, donationDescription, donationSuggestedCents, donationMinCents }) },
      order: h.order,
    };
  }

  /** Prices for a hold with an optional promo code, before an order exists. */
  async quoteHold(input: PriceInput & { holdId: string }) {
    const hold = await this.prisma.hold.findUnique({ where: { id: input.holdId }, include: { ticketType: true, event: true } });
    if (!hold) throw new NotFoundException('Hold not found.');
    const p = await this.price(hold, input);
    return { promo: p.promo, ...p.q, ticketTotalCents: p.q.totalCents - p.q.donationCents, feeCents: p.feeCents, amountCents: p.amountCents };
  }

  /**
   * The prices for a hold: the ticket price (pay what you want: the chosen amount, from the order or the hold,
   * checked again), any promo code (refused on pay-what-you-want tiers), protection and a donation (checked against
   * the event's settings; no fee, discount or protection on it).
   */
  private async price(
    hold: { eventId: string; quantity: number; amountCents: number | null; donationCents: number; ticketType: PwywTier & { priceCents: number }; event: DonationSettings & { feeMode: 'BUYER' | 'ORGANIZER'; currency: string } },
    input: PriceInput,
  ) {
    const { unitCents, amountCents } = unitFor(hold.ticketType, hold.event, input.amountCents ?? hold.amountCents);
    let promo: { code: string; percent: number } | null = null;
    if (input.promoCode) {
      if (isPwyw(hold.ticketType)) throw new BadRequestException(PROMO_ON_PWYW);
      const p = await this.prisma.promo.findUnique({ where: { eventId_code: { eventId: hold.eventId, code: input.promoCode.trim().toUpperCase() } } });
      if (!p || !p.active || (p.limit !== null && p.used >= p.limit)) throw new BadRequestException('That promo code isn’t valid for this event.');
      promo = { code: p.code, percent: p.percent };
    }
    // Left out: the donation stored on the hold (chosen in the app before the card payment moved to the website).
    const donationCents = fanRule(() => checkDonation(hold.event, input.donationCents ?? hold.donationCents, hold.event.currency));
    // The donation goes on top of the tickets' quote as it is: no fee, discount or protection applies to it.
    const t = quote(unitCents, hold.quantity, promo?.percent ?? null, !!input.protection);
    const q = { ...t, donationCents, totalCents: t.totalCents + donationCents };
    return { promo, q, amountCents, feeCents: buyerFee(unitCents, hold.quantity, hold.event.feeMode) };
  }

  /**
   * Stores what the fan chose on a hold before checkout moves elsewhere (the app hands card payments to the website):
   * the donation and, for pay what you want, the amount per ticket. Checked exactly as at the order, and again there.
   * The hold id is the key, as for the quote and the order.
   */
  async updateHold(id: string, input: { donationCents?: number; amountCents?: number }) {
    const hold = await this.prisma.hold.findUnique({ where: { id }, include: { ticketType: true, event: true, order: { select: { id: true } } } });
    if (!hold) throw new NotFoundException('Hold not found.');
    if (hold.order) throw new ConflictException('An order already exists for these seats.');
    if (hold.status !== 'ACTIVE' || hold.expiresAt <= new Date()) throw new ConflictException('Your seats were released. Please pick them again.');
    const data: Prisma.HoldUpdateInput = {};
    if (input.amountCents !== undefined) {
      if (!isPwyw(hold.ticketType)) throw new BadRequestException('These tickets have a set price.');
      data.amountCents = unitFor(hold.ticketType, hold.event, input.amountCents).amountCents;
    }
    if (input.donationCents !== undefined) data.donationCents = fanRule(() => checkDonation(hold.event, input.donationCents, hold.event.currency));
    if (Object.keys(data).length) await this.prisma.hold.update({ where: { id }, data });
    return this.getHold(id);
  }

  async releaseHold(id: string) {
    const { count } = await this.prisma.hold.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
    if (!count) throw new NotFoundException('Hold not found or already used.');
    return { released: true };
  }

  /* ---------- orders ---------- */

  /**
   * Paystack split for organizers paid through a Paystack subaccount: their share of the tickets (after Omoshow's fee
   * and any discount) settles straight to their bank; Omoshow keeps the rest (fee and ticket protection).
   * No split while payouts are on hold after a bank change, or if the sale is in a different currency than their bank.
   */
  private async paystackSplit(orgId: string, currency: string, q: { unitCents: number; quantity: number; discountCents: number; totalCents: number; donationCents: number }, feeMode: 'BUYER' | 'ORGANIZER') {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { payoutProvider: true, paystackSubaccount: true, bankCountry: true, payoutHoldUntil: true } });
    if (org?.payoutProvider !== 'paystack' || !org.paystackSubaccount) return {};
    if (org.payoutHoldUntil && org.payoutHoldUntil > new Date()) return {};
    if (paystackCountryFor(currency)?.code !== org.bankCountry) return {};
    // The organizer's share of the tickets, plus the whole donation (Omoshow takes no fee on it).
    const share = Math.max(0, organizerNet(q.unitCents, feeMode, config.organizerFeePermille) * q.quantity - q.discountCents) + q.donationCents;
    return { split: { subaccount: org.paystackSubaccount, platformCents: Math.max(0, q.totalCents - share) } };
  }

  async createOrder(
    input: PriceInput & { holdId: string; email: string; name: string; gift?: GiftInput; returnTo?: 'app' },
    user: AuthUser | null,
    clientIp: string | null,
  ) {
    const now = new Date();
    const hold = await this.prisma.hold.findUnique({ where: { id: input.holdId }, include: { ticketType: true, event: { include: { dates: true } }, order: true } });
    if (!hold) throw new NotFoundException('Hold not found.');
    if (hold.order) throw new ConflictException('An order already exists for these seats.');
    if (hold.status !== 'ACTIVE' || hold.expiresAt <= now) throw new ConflictException('Your seats were released. Please pick them again.');

    // The price is worked out again here (pay what you want and the donation are checked again, promos refused on PWYW).
    const { promo, q, amountCents, feeCents } = await this.price(hold, input);
    const gift = input.gift ? this.gifts.validate(input.gift, input.email, ticketTimes(hold.event.dateMode, hold.event, hold.ticketType, hold.event.dates).first.startsAt) : null;
    const since = new Date(now.getTime() - 10 * 60_000);
    const [sameEmail, sameIp] = await Promise.all([
      this.prisma.order.count({ where: { email: input.email, createdAt: { gte: since } } }),
      clientIp ? this.prisma.order.count({ where: { clientIp, createdAt: { gte: since } } }) : Promise.resolve(0),
    ]);
    const risk = scoreOrder({
      email: input.email,
      // Fraud rules are written in US dollars; other currencies are converted (approximately).
      totalCents: this.fx.convert(q.totalCents, hold.event.currency, 'USD'),
      quantity: hold.quantity,
      maxPerOrder: hold.ticketType.maxPerOrder,
      recentOrdersSameEmail: sameEmail + 1,
      recentOrdersSameIp: sameIp + 1,
      secondsToCheckout: (now.getTime() - hold.createdAt.getTime()) / 1000,
    });

    const id = orderCode();
    const currency: Currency = isCurrency(hold.event.currency) ? hold.event.currency : 'USD';
    // Nothing to pay (free tickets, $0 pay what you want, no donation): no payment provider, the tickets are issued now.
    const free = q.totalCents === 0;
    const provider = free ? null : this.payments.forCurrency(currency);
    const order = await this.prisma.order.create({
      data: {
        id,
        eventId: hold.eventId,
        ticketTypeId: hold.ticketTypeId,
        holdId: hold.id,
        buyerId: user?.id ?? null,
        email: input.email,
        buyerName: input.name.trim(),
        quantity: hold.quantity,
        unitCents: q.unitCents,
        subtotalCents: q.subtotalCents,
        discountCents: q.discountCents,
        protectionCents: q.protectionCents,
        totalCents: q.totalCents,
        donationCents: q.donationCents,
        donationCause: q.donationCents > 0 ? hold.event.donationCause : null,
        promoCode: promo?.code ?? null,
        currency,
        provider: provider?.name ?? 'free',
        clientIp,
        ...(risk.score >= FRAUD_FLAG_THRESHOLD ? { fraudFlag: { create: { score: risk.score, reasons: risk.reasons } } } : {}),
        ...(gift ? { gift: { create: gift } } : {}),
      },
    });
    const extra = { donationCents: q.donationCents, ticketTotalCents: q.totalCents - q.donationCents, feeCents, amountCents };

    if (!provider) {
      const done = await this.fulfil(id);
      return { orderId: id, status: done.status, provider: 'free', currency, clientSecret: null, redirectUrl: null, holdExpiresAt: hold.expiresAt, ...q, ...extra };
    }

    const pay = await provider.createPayment({
      orderId: id,
      amountCents: q.totalCents,
      currency,
      email: input.email,
      description: `${hold.quantity} × ${hold.ticketType.name} — ${hold.event.title}`,
      returnTo: input.returnTo,
      ...(provider.name === 'paystack' ? await this.paystackSplit(hold.event.orgId, currency, q, hold.event.feeMode) : {}),
    });
    await this.prisma.order.update({ where: { id }, data: { paymentRef: pay.paymentRef } });

    return {
      orderId: order.id,
      status: order.status,
      provider: provider.name,
      currency,
      clientSecret: pay.clientSecret ?? null,
      redirectUrl: pay.redirectUrl ?? null,
      holdExpiresAt: hold.expiresAt,
      ...q,
      ...extra,
    };
  }

  /**
   * Pays for a fan-resale listing the buyer is holding (POST /resale/:id/hold gave them the key), with an optional
   * donation to the event's cause (checked as at a normal order). The donation is the organizer's, not the seller's:
   * the seller's payout comes from the listing price only (fulfil), no Omoshow fee is taken on it, and it counts in
   * the organizer's donations and payouts. With Paystack and an organizer paid through a subaccount, the payment is
   * split so the donation settles to the organizer, as on a normal order; the listing price stays with Omoshow, which
   * pays the seller (and keeps its resale fee) as before.
   */
  async createResaleOrder(listingId: string, input: { holdKey: string; email: string; name: string; returnTo?: 'app'; donationCents?: number }, user: AuthUser | null, clientIp: string | null) {
    const l = await this.prisma.resaleListing.findUnique({ where: { id: listingId }, include: { event: true, ticket: { include: { ticketType: true } }, order: true } });
    if (!l || l.status !== 'HELD' || l.heldBy !== input.holdKey || !l.heldUntil || l.heldUntil <= new Date()) {
      throw new ConflictException('Your hold on that ticket ran out. Pick it again.');
    }
    if (l.order) throw new ConflictException('An order already exists for this ticket.');
    if (user?.id === l.sellerId) throw new BadRequestException('That’s your own listing.');
    const donationCents = fanRule(() => checkDonation(l.event, input.donationCents, l.event.currency));
    const totalCents = l.priceCents + donationCents;
    const id = orderCode();
    const currency: Currency = isCurrency(l.currency) ? l.currency : 'USD';
    const provider = this.payments.forCurrency(currency);
    const order = await this.prisma.order.create({
      data: {
        id,
        eventId: l.eventId,
        ticketTypeId: l.ticket.ticketTypeId,
        buyerId: user?.id ?? null,
        email: input.email,
        buyerName: input.name.trim(),
        quantity: 1,
        unitCents: l.priceCents,
        subtotalCents: l.priceCents,
        totalCents,
        donationCents,
        donationCause: donationCents > 0 ? l.event.donationCause : null,
        currency,
        provider: provider.name,
        clientIp,
        resaleListingId: l.id,
      },
    });
    // Paystack split: only the donation goes to the organizer's subaccount (a resale order's ticket share is the
    // seller's, paid out by Omoshow). Same rules as a normal order (subaccount, no payout hold, same currency).
    const split =
      provider.name === 'paystack' && donationCents > 0 ? await this.paystackSplit(l.event.orgId, currency, { unitCents: 0, quantity: 1, discountCents: 0, totalCents, donationCents }, l.event.feeMode) : {};
    const pay = await provider.createPayment({ orderId: id, amountCents: totalCents, currency, email: input.email, description: `Resale: ${l.ticket.ticketType.name} — ${l.event.title}`, returnTo: input.returnTo, ...split });
    await this.prisma.order.update({ where: { id }, data: { paymentRef: pay.paymentRef } });
    return {
      orderId: order.id,
      status: order.status,
      provider: provider.name,
      currency,
      clientSecret: pay.clientSecret ?? null,
      redirectUrl: pay.redirectUrl ?? null,
      holdExpiresAt: l.heldUntil,
      unitCents: l.priceCents,
      subtotalCents: l.priceCents,
      discountCents: 0,
      protectionCents: 0,
      donationCents,
      ticketTotalCents: l.priceCents,
      totalCents,
    };
  }

  /** Development only: completes a mock payment. */
  async payMock(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    // A $0 order was completed when it was made: this just returns it.
    if (o.provider === 'free') return this.fulfil(orderId);
    if (o.provider !== 'mock') throw new ForbiddenException('This order is paid through a payment provider.');
    if (config.isProduction) throw new ForbiddenException('Test payments are switched off on this site.');
    return this.fulfil(orderId);
  }

  /**
   * Called when a fan comes back from Paystack: asks Paystack whether the payment went through, then fulfils.
   * Safe to call more than once and from anyone (it only completes orders Paystack confirms were paid in full).
   */
  /**
   * The website asks us to confirm a payment after the fan pays (Paystack's page, or Stripe's card form).
   * We ask the provider directly rather than waiting for the webhook, so the confirmation shows straight away.
   */
  async verifyPaystack(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    if (o.status === 'PAID') return this.orderView(orderId);
    if (o.provider === 'stripe') return this.verifyStripe(o);
    if (o.provider !== 'paystack') throw new BadRequestException('This order isn’t paid through Paystack.');
    if (!this.payments.paystack) throw new BadRequestException('Paystack isn’t configured on this server.');
    const t = await this.payments.paystack.verify(o.paymentRef ?? o.id);
    if (t.status !== 'success') return { ...(await this.orderView(orderId)), paymentStatus: t.status };
    if (t.amount !== o.totalCents || t.currency !== o.currency) {
      this.log.error(`Paystack amount mismatch on ${o.id}: paid ${t.amount} ${t.currency}, expected ${o.totalCents} ${o.currency}`);
      throw new BadRequestException('The payment amount doesn’t match the order. Our team has been alerted.');
    }
    return this.fulfil(orderId);
  }

  /** Paystack webhook (charge.success). The signature is checked by the controller. */
  async handlePaystackEvent(event: string, data: { reference?: string }) {
    if (event !== 'charge.success' || !data.reference) return;
    try {
      await this.verifyPaystack(data.reference);
    } catch (e) {
      this.log.warn(`Paystack webhook for ${data.reference} ended with: ${(e as Error).message}`);
    }
  }

  /**
   * Marks an order paid and issues tickets. Safe to call more than once (webhook retries).
   * If the hold expired during payment and the seats are gone, the payment is refunded.
   */
  private async verifyStripe(o: { id: string; paymentRef: string | null; totalCents: number; currency: string }) {
    const stripe = this.payments.stripe;
    if (!stripe || !o.paymentRef) throw new BadRequestException('Card payments aren’t configured on this server.');
    const pi = await stripe.paymentIntents.retrieve(o.paymentRef);
    if (pi.metadata?.orderId !== o.id) throw new BadRequestException('That payment belongs to a different order.');
    if (pi.status !== 'succeeded') return { ...(await this.orderView(o.id)), paymentStatus: pi.status };
    if (pi.amount !== o.totalCents || pi.currency.toUpperCase() !== o.currency) {
      this.log.error(`Stripe amount mismatch on ${o.id}: paid ${pi.amount} ${pi.currency}, expected ${o.totalCents} ${o.currency}`);
      throw new BadRequestException('The payment amount doesn’t match the order. Our team has been alerted.');
    }
    return this.fulfil(o.id);
  }

  async fulfil(orderId: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({ where: { id: orderId }, include: { hold: true, event: { include: { dates: true } }, ticketType: true, gift: true } });
        if (!order) throw new NotFoundException('Order not found.');
        if (order.status !== 'PENDING') return { order, refund: false, fresh: false };
        // Paid after the event (or, with multiple dates, its date) was cancelled (the payment was already under way):
        // refund it instead of issuing tickets.
        const dateCancelled = order.event.dates.some((d) => d.id === order.ticketType.eventDateId && d.status === 'CANCELLED');
        if (order.event.status === 'CANCELLED' || dateCancelled) {
          await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
          if (order.hold?.status === 'ACTIVE') await tx.hold.update({ where: { id: order.hold.id }, data: { status: 'RELEASED' } });
          return { order, refund: true, fresh: false, eventCancelled: true };
        }

        if (order.resaleListingId) {
          // Fan resale: the seller's ticket is cancelled and the buyer gets a new ticket for the same seat.
          await tx.$queryRaw`SELECT id FROM "ResaleListing" WHERE id = ${order.resaleListingId} FOR UPDATE`;
          const l = await tx.resaleListing.findUnique({ where: { id: order.resaleListingId }, include: { ticket: { include: { ticketType: true } } } });
          if (!l || l.status !== 'HELD' || l.ticket.status !== 'LISTED') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
            return { order, refund: true, fresh: false };
          }
          const old = l.ticket;
          const owner = order.buyerId ?? (await tx.user.findUnique({ where: { email: order.email }, select: { id: true } }))?.id ?? null;
          await tx.ticket.update({ where: { id: old.id }, data: { status: 'VOID', listCents: null, resoldAt: new Date(), section: null, row: null, seat: null } });
          // The seller's session bookings don't pass to the buyer's new ticket: the places go back.
          await releaseReservations(tx, { id: old.id });
          await tx.ticket.create({
            data: {
              id: ticketCode(order.id, 0),
              orderId: order.id,
              eventId: order.eventId,
              ticketTypeId: old.ticketTypeId,
              ownerId: owner,
              holderName: order.buyerName,
              holderEmail: order.email,
              section: old.section,
              row: old.row,
              seat: old.seat,
              eventDateId: old.eventDateId,
              dateKey: old.dateKey,
              // Bought on fan resale: covered by the resale scan guarantee (GuaranteeService), even after a transfer.
              resaleGuarantee: true,
            },
          });
          const fee = Math.round((l.priceCents * config.resaleFeePermille) / 1000);
          const royalty = Math.round((l.priceCents * order.event.resaleRoyaltyPermille) / 1000);
          await tx.resaleListing.update({
            where: { id: l.id },
            data: {
              status: 'SOLD',
              soldAt: new Date(),
              heldBy: null,
              sellerFeeCents: fee,
              royaltyCents: royalty,
              payoutCents: Math.max(0, l.priceCents - fee - royalty),
              payoutStatus: 'PENDING',
              // a day after the event (event times are wall-clock UTC, so a day covers the time zone); with more than one
              // date, a day after the ticket's date (DATES) or its last valid day (DAYS)
              payoutAvailableAt: new Date(ticketTimes(order.event.dateMode, order.event, old.ticketType, order.event.dates).last.startsAt.getTime() + 86_400_000),
            },
          });
          const paid = await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: new Date(), buyerId: owner } });
          return { order: paid, refund: false, fresh: true };
        }

        await lockTicketType(tx, order.ticketTypeId);

        const now = new Date();
        const holdLive = order.hold?.status === 'ACTIVE';
        if (!holdLive || order.hold!.expiresAt <= now) {
          // Seats were released: only proceed if they're still free.
          const left = await this.inventory.availableForType(tx, order.ticketTypeId, now);
          if (left < order.quantity) {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
            if (order.hold) await tx.hold.update({ where: { id: order.hold.id }, data: { status: 'EXPIRED' } });
            return { order, refund: true, fresh: false };
          }
        }

        const held = holdLive && order.hold!.expiresAt > now ? ((order.hold!.seats as SeatPick[] | null) ?? null) : null;
        const seats = held?.length === order.quantity ? held : await this.pickSeats(tx, order.eventId, order.event.seatMap as SeatMap | null, order.ticketType, order.hold?.sectionId ?? null, order.quantity, now);
        const owner = order.buyerId ?? (await tx.user.findUnique({ where: { email: order.email }, select: { id: true } }))?.id ?? null;

        await tx.ticket.createMany({
          data: seats.map((s, i) => ({
            id: ticketCode(order.id, i),
            orderId: order.id,
            eventId: order.eventId,
            ticketTypeId: order.ticketTypeId,
            ownerId: owner,
            // A gift's tickets are held for the recipient: nobody can use them until they claim the gift.
            holderName: order.gift ? order.gift.recipientName : order.buyerName,
            holderEmail: order.email,
            ...(order.gift ? { status: 'TRANSFER_PENDING' as const } : {}),
            section: s.section,
            row: s.row,
            seat: s.seat,
            ...ticketDateFields(order.ticketType),
          })),
        });
        await tx.ticketType.update({ where: { id: order.ticketTypeId }, data: { sold: { increment: order.quantity } } });
        if (order.hold) await tx.hold.update({ where: { id: order.hold.id }, data: { status: 'CONVERTED' } });
        if (order.promoCode) {
          await tx.promo.update({ where: { eventId_code: { eventId: order.eventId, code: order.promoCode } }, data: { used: { increment: 1 } } });
        }
        const paid = await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now, buyerId: owner } });
        return { order: paid, refund: false, fresh: true };
      },
      { timeout: 20_000 },
    );

    if (result.refund && result.order.paymentRef) {
      const cancelled = 'eventCancelled' in result && result.eventCancelled;
      await this.payments.byName(result.order.provider).refund(result.order.paymentRef, result.order.totalCents);
      await this.audit.log(null, 'order.auto_refund', 'Order', orderId, { reason: cancelled ? 'event was cancelled before payment finished' : 'seats no longer available after hold expired' });
      throw new ConflictException(
        cancelled ? 'This event was cancelled before your payment finished. You have been refunded in full.' : 'Your seats were released before payment finished. You have been refunded in full.',
      );
    }
    // Only the call that actually marked it paid sends the receipt (webhook retries don't send it again).
    if (result.fresh) {
      void this.sendReceipt(orderId).catch((e) => this.log.warn(`Receipt for ${orderId}: ${(e as Error).message}`));
      void this.gifts.afterPaid(orderId).catch((e) => this.log.warn(`Gift for ${orderId}: ${(e as Error).message}`));
      if (result.order.resaleListingId) void this.resale.soldEmail(result.order.resaleListingId).catch((e) => this.log.warn(`Resale email for ${orderId}: ${(e as Error).message}`));
      // Push (never throws): the buyer's "You're going", the organizer team's "New sale", and the seller's "Your ticket sold".
      void this.notices.orderPaid(orderId);
      void this.notices.newSale(orderId);
      if (result.order.resaleListingId) void this.notices.resaleSold(result.order.resaleListingId);
    }
    return this.orderView(orderId);
  }

  private async sendReceipt(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { title: true, startsAt: true, online: true, dateMode: true, dates: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { name: true, eventDateId: true, validDateIds: true } },
        tickets: { select: { section: true, row: true, seat: true }, orderBy: { id: 'asc' } },
        gift: true,
      },
    });
    if (!o) return;
    const giftLine = o.gift
      ? `This is a gift for ${o.gift.recipientName} (${o.gift.recipientEmail}). ${
          o.gift.sendAt > new Date() ? `We’ll deliver it on ${o.gift.sendAt.toUTCString().slice(0, 16)}.` : 'We’ve sent it to them.'
        } The tickets move to their account when they open it.`
      : null;
    // The ticket's own date with multiple dates; its days for a multi-day pass.
    const when = whenText(o.event.dateMode, o.event, o.ticketType, o.event.dates);
    const where = o.event.online ? 'Online' : o.event.venue ? `${o.event.venue.name}, ${o.event.venue.city}` : '';
    const seats = o.tickets.filter((t) => t.seat !== null).map((t) => `${t.section} · Row ${t.row} · Seat ${t.seat}`);
    const { html, text } = render({
      preheader: `${o.quantity} × ${o.ticketType.name} for ${o.event.title}. Order ${o.id}.`,
      heading: `You're going to ${o.event.title}`,
      highlight: { label: `Order ${o.id} · ${o.totalCents > 0 ? 'paid' : 'confirmed'}`, value: o.totalCents > 0 ? formatMoney(o.totalCents, o.currency) : 'Free' },
      paragraphs: [
        `${o.quantity} × ${o.ticketType.name}: ${o.totalCents - o.donationCents > 0 ? formatMoney(o.totalCents - o.donationCents, o.currency) : 'Free'}`,
        ...(o.donationCents > 0
          ? [
              `Donation to ${o.donationCause ?? 'the organizer’s cause'}: ${formatMoney(o.donationCents, o.currency)}. Thank you! Omoshow collects donations on the organizer's behalf; the organizer is responsible for passing them to the cause. Donations aren’t refunded if a ticket doesn’t scan.`,
            ]
          : []),
        `${when}${where ? ` · ${where}` : ''}`,
        ...(seats.length ? [`Seats: ${seats.join('; ')}`] : []),
        giftLine ?? 'Your tickets are in your Omoshow account. The QR code refreshes every few seconds, so screenshots won’t work at the door.',
      ],
      cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
      footer: 'You got this email because you bought tickets on Omoshow. Need help?',
      footerLink: { label: 'Visit the help centre', url: `${config.webUrl}/help` },
    });
    await this.mail.send('order.receipt', { to: o.email, subject: `Your tickets: ${o.event.title} (${o.id})`, html, text });
  }

  /** Best-available seats for a paid order. GA sections and events without a map get no seat numbers. */
  private async pickSeats(tx: Tx, eventId: string, map: SeatMap | null, tt: { id: string; tierKey: string | null; eventDateId: string | null }, sectionId: string | null, qty: number, now: Date): Promise<SeatPick[] | { section: null; row: null; seat: null }[]> {
    const tier = seatTier(tt);
    let sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === tier && (!sectionId || s.id === sectionId));
    if (!sections.length && sectionId) sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === tier);
    if (!sections.length) return Array.from({ length: qty }, () => ({ section: null, row: null, seat: null }));
    const inUse = await this.inventory.seatsInUse(tx, eventId, sections.map((s) => s.id), now, undefined, tt.eventDateId);
    const picked = pickFromSections(sections, inUse, qty);
    if (!picked) throw new ConflictException('Not enough seats together. Try fewer tickets or another section.');
    return picked;
  }

  async orderView(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { slug: true, title: true, startsAt: true, dateMode: true, dates: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { ...TIER_FIELDS, eventDateId: true, validDateIds: true } },
        tickets: { select: { id: true, section: true, row: true, seat: true, status: true, holderName: true }, orderBy: { id: 'asc' } },
        gift: { select: { id: true, recipientName: true, recipientEmail: true, message: true, sendAt: true, sentAt: true, claimedAt: true } },
      },
    });
    if (!o) throw new NotFoundException('Order not found.');
    // A comp's note and issuer are the organizer's own.
    const { clientIp: _ip, paymentRef: _ref, compNote: _note, compIssuedById: _by, ...safe } = o;
    const { dates, ...event } = safe.event;
    return { ...safe, event, ticketType: withLook(safe.ticketType), ...ticketDates(event.dateMode, safe.ticketType, dates) };
  }

  async getOrder(orderId: string, user: AuthUser | null, email?: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true, email: true } });
    const allowed = o && ((user && (o.buyerId === user.id || user.roles.includes('ADMIN'))) || (email && email.trim().toLowerCase() === o.email));
    if (!allowed) throw new NotFoundException('Order not found.');
    // The buyer (or an admin) also sees refund requests, newest first, so the app can show where one stands.
    const refundRequests = await this.prisma.refundRequest.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, reason: true, amountCents: true, createdAt: true, decidedAt: true },
    });
    return { ...(await this.orderView(orderId)), refundRequests };
  }

  /**
   * The signed-in fan's orders (bought on their account or with their email), newest first, for order history.
   * Abandoned checkouts (never paid) are left out. Each row has the event, the ticket type and the latest refund request.
   */
  async myOrders(user: AuthUser) {
    const rows = await this.prisma.order.findMany({
      where: {
        AND: [
          { OR: [{ buyerId: user.id }, { email: user.email }] },
          { OR: [{ status: { in: ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }, { status: 'CANCELLED', paidAt: { not: null } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        quantity: true,
        unitCents: true,
        subtotalCents: true,
        protectionCents: true,
        discountCents: true,
        totalCents: true,
        refundedCents: true,
        kind: true,
        donationCents: true,
        donationCause: true,
        donationRefundedCents: true,
        compGroup: true,
        promoCode: true,
        currency: true,
        provider: true,
        createdAt: true,
        paidAt: true,
        resaleListingId: true,
        event: { select: { slug: true, title: true, startsAt: true, timezone: true, imageUrl: true, status: true, dateMode: true, dates: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { ...TIER_FIELDS, eventDateId: true, validDateIds: true } },
        gift: { select: { recipientName: true, sendAt: true, sentAt: true, claimedAt: true } },
        refunds: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, createdAt: true, decidedAt: true, amountCents: true } },
      },
    });
    return {
      orders: rows.map(({ refunds, resaleListingId, event: { dates, ...event }, ...o }) => ({
        ...o,
        event,
        ticketType: withLook(o.ticketType),
        ...ticketDates(event.dateMode, o.ticketType, dates),
        resale: !!resaleListingId,
        refundRequest: refunds[0] ?? null,
      })),
    };
  }

  async requestRefund(orderId: string, user: AuthUser, reason: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o || (o.buyerId !== user.id && o.email !== user.email)) throw new NotFoundException('Order not found.');
    if (o.status !== 'PAID') throw new BadRequestException('Only paid orders can be refunded.');
    if (o.kind === 'COMP') throw new BadRequestException('This is a complimentary ticket, so there’s nothing to refund.');
    const open = await this.prisma.refundRequest.findFirst({ where: { orderId, status: 'OPEN' } });
    if (open) throw new ConflictException('There’s already an open refund request for this order.');
    return this.prisma.refundRequest.create({ data: { orderId, reason: reason.trim() } });
  }

  /** Stripe webhook events we act on. */
  async handleStripeEvent(type: string, obj: { id?: string; metadata?: Record<string, string> }) {
    const orderId = obj.metadata?.orderId;
    if (!orderId) return;
    if (type === 'payment_intent.succeeded') {
      try {
        await this.fulfil(orderId);
      } catch (e) {
        this.log.warn(`Fulfilment for ${orderId} ended with: ${(e as Error).message}`);
      }
    } else if (type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled') {
      const o = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (o?.status === 'PENDING') {
        await this.prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
        if (o.holdId) await this.prisma.hold.updateMany({ where: { id: o.holdId, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      }
    }
  }
}
