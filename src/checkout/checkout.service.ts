import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { checkAnswers, questionsOf, type AnswerInput } from '../domain/questions';
import { presaleOpen, saleState } from '../domain/presale';
import { TIER_FIELDS, withLook } from '../domain/tier-look';
import { InventoryService } from '../common/inventory.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { cartCode, isCartCode, orderCode, ticketCode } from '../domain/codes';
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
import { purchaseSnapshot, seatTier, ticketDateFields, ticketDates, ticketTimes, whenText } from '../domain/event-dates';
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

/** Tickets across the lines of one cart. */
const CART_MAX_TICKETS = 20;

/** "Can't find my order?" emails per address per hour. */
const FIND_PER_EMAIL_PER_HOUR = 3;

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

  async createHold(input: { ticketTypeId: string; quantity: number; sectionId?: string; seats?: { row: string; seat: number }[]; amountCents?: number; accessCode?: string }, user: AuthUser | null) {
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
      // Multi-day: a ticket whose every day was cancelled has nothing left to admit to.
      if (ev.dateMode === 'DAYS' && tt.validDateIds.length && !ev.dates.some((d) => tt.validDateIds.includes(d.id) && d.status === 'ACTIVE')) throw new BadRequestException('The day these tickets were for was cancelled.');
      if (ticketTimes(ev.dateMode, ev, tt, ev.dates).first.startsAt <= now) throw new BadRequestException(date ? 'This date has already started.' : 'This event has already started.');
      if (tt.salesEnd && tt.salesEnd <= now) throw new BadRequestException('Sales of these tickets have ended.');
      // Not on public sale yet: the event's presale code opens it early (from when the presale starts).
      if (tt.salesStart && tt.salesStart > now && !presaleOpen(ev, input.accessCode, now)) {
        throw new BadRequestException(input.accessCode ? 'That presale code isn’t right, or the presale hasn’t opened yet.' : 'These tickets aren’t on sale yet.');
      }
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
            minAge: true,
            questions: true,
            venue: { select: { name: true, city: true, address: true } },
          },
        },
        order: { select: { id: true, status: true } },
      },
    });
    if (!h) throw new NotFoundException('Hold not found.');
    const { seatMap, donationsEnabled, donationCause, donationDescription, donationSuggestedCents, donationMinCents, dates, questions, ...event } = h.event;
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
      // Questions the organizer asks at checkout (answers go with POST /orders).
      questions: questionsOf(questions),
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

  /** The same split for a cart: `shareCents` is the organizer's share of every line plus the donation. */
  private async paystackSplitFor(orgId: string, currency: string, shareCents: number, totalCents: number) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { payoutProvider: true, paystackSubaccount: true, bankCountry: true, payoutHoldUntil: true } });
    if (org?.payoutProvider !== 'paystack' || !org.paystackSubaccount) return {};
    if (org.payoutHoldUntil && org.payoutHoldUntil > new Date()) return {};
    if (paystackCountryFor(currency)?.code !== org.bankCountry) return {};
    return { split: { subaccount: org.paystackSubaccount, platformCents: Math.max(0, totalCents - shareCents) } };
  }

  async createOrder(
    input: PriceInput & { holdId: string; email: string; name: string; gift?: GiftInput; returnTo?: 'app'; answers?: AnswerInput[] },
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

    // The organizer's checkout questions: required ones answered, choices from the list.
    const [answers] = checkAnswers(questionsOf(hold.event.questions), input.answers, [hold.quantity]);
    const id = orderCode();
    const currency: Currency = isCurrency(hold.event.currency) ? hold.event.currency : 'USD';
    // Nothing to pay (free tickets, $0 pay what you want, no donation): no payment provider, the tickets are issued now.
    const free = q.totalCents === 0;
    const provider = free ? null : this.payments.forCurrency(currency);
    // What they're buying, as it is now (the event and tier can change later; support and refunds go by this).
    const venue = hold.event.venueId ? await this.prisma.venue.findUnique({ where: { id: hold.event.venueId }, select: { name: true, city: true } }) : null;
    const snapshot = purchaseSnapshot(hold.event, hold.ticketType, venue, hold.event.dates, q.unitCents);
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
        snapshot,
        ...(answers ? { answers } : {}),
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
        snapshot: purchaseSnapshot(
          l.event,
          l.ticket.ticketType,
          l.event.venueId ? await this.prisma.venue.findUnique({ where: { id: l.event.venueId }, select: { name: true, city: true } }) : null,
          await this.prisma.eventDate.findMany({ where: { eventId: l.eventId } }),
          l.priceCents,
        ),
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

  /* ---------- carts: several ticket types of one event in one checkout ---------- */

  /** A presale code for an event: right or not, and the ticket types it opens before their public on-sale. */
  async checkPresale(slug: string, code: string) {
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { status: true, presaleCode: true, presaleStartsAt: true, ticketTypes: { select: { id: true, salesStart: true, salesEnd: true } } } });
    if (!e || e.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    const now = new Date();
    if (!e.presaleCode || e.presaleCode.toUpperCase() !== code.trim().toUpperCase()) throw new BadRequestException('That code isn’t right for this event.');
    if (e.presaleStartsAt && e.presaleStartsAt > now) return { ok: false, opensAt: e.presaleStartsAt, ticketTypeIds: [] as string[] };
    return { ok: true, opensAt: e.presaleStartsAt, ticketTypeIds: e.ticketTypes.filter((t) => saleState(t, now) === 'SOON').map((t) => t.id) };
  }

  /**
   * Holds every line of a cart (POST /holds/cart), all or nothing: if one line can't be held (sold out, off sale),
   * the ones already made are released and the fan sees why. Each line is an ordinary hold, so the seats, timer and
   * pay-what-you-want amount work as for a single ticket type.
   */
  async createCartHolds(items: { ticketTypeId: string; quantity: number; amountCents?: number }[], user: AuthUser | null, accessCode?: string) {
    const ids = items.map((i) => i.ticketTypeId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each ticket type can be in the cart once: change its quantity instead.');
    if (items.reduce((n, i) => n + i.quantity, 0) > CART_MAX_TICKETS) throw new BadRequestException(`You can buy up to ${CART_MAX_TICKETS} tickets in one order.`);
    const types = await this.prisma.ticketType.findMany({ where: { id: { in: ids } }, select: { id: true, eventId: true } });
    if (types.length !== ids.length) throw new NotFoundException('Ticket type not found.');
    if (new Set(types.map((t) => t.eventId)).size > 1) throw new BadRequestException('A cart holds tickets for one event at a time.');
    const holds: Awaited<ReturnType<CheckoutService['createHold']>>[] = [];
    try {
      for (const i of items) holds.push(await this.createHold({ ...i, accessCode }, user));
    } catch (e) {
      await this.prisma.hold.updateMany({ where: { id: { in: holds.map((h) => h.id) }, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      throw e;
    }
    return { holds, expiresAt: new Date(Math.min(...holds.map((h) => h.expiresAt.getTime()))) };
  }

  /** The holds of a cart, in the order given: all there, for one event. */
  private async cartHolds(holdIds: string[]) {
    if (new Set(holdIds).size !== holdIds.length) throw new BadRequestException('The same hold is listed twice.');
    const rows = await this.prisma.hold.findMany({ where: { id: { in: holdIds } }, include: { ticketType: true, event: { include: { dates: true } }, order: { select: { id: true } } } });
    const holds = holdIds.map((id) => rows.find((r) => r.id === id));
    if (holds.some((h) => !h)) throw new NotFoundException('Hold not found.');
    if (new Set(rows.map((r) => r.eventId)).size > 1) throw new BadRequestException('A cart holds tickets for one event at a time.');
    return holds as NonNullable<(typeof holds)[number]>[];
  }

  /**
   * Prices a cart line by line with the same rules as a single hold. A promo code applies to the fixed-price lines
   * (it's refused only if every line is pay what you want); protection applies to every line; the donation is one
   * amount for the whole cart, carried by the first line.
   */
  private async priceCart(holds: Awaited<ReturnType<CheckoutService['cartHolds']>>, input: { promoCode?: string; protection?: boolean; donationCents?: number }) {
    if (input.promoCode && holds.every((h) => isPwyw(h.ticketType))) throw new BadRequestException(PROMO_ON_PWYW);
    const lines = await Promise.all(
      holds.map(async (hold, i) => ({
        hold,
        ...(await this.price(hold, {
          promoCode: input.promoCode && !isPwyw(hold.ticketType) ? input.promoCode : undefined,
          protection: input.protection,
          donationCents: i === 0 ? (input.donationCents ?? 0) : 0,
        })),
      })),
    );
    const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((n, l) => n + f(l), 0);
    const totals = {
      quantity: sum((l) => l.q.quantity),
      subtotalCents: sum((l) => l.q.subtotalCents),
      discountCents: sum((l) => l.q.discountCents),
      protectionCents: sum((l) => l.q.protectionCents),
      donationCents: sum((l) => l.q.donationCents),
      totalCents: sum((l) => l.q.totalCents),
      feeCents: sum((l) => l.feeCents),
    };
    return { lines, totals: { ...totals, ticketTotalCents: totals.totalCents - totals.donationCents }, promo: lines.find((l) => l.promo)?.promo ?? null };
  }

  /** What a cart's lines look like in a quote or an order answer. */
  private cartLineView(l: Awaited<ReturnType<CheckoutService['priceCart']>>['lines'][number]) {
    return { holdId: l.hold.id, ticketTypeId: l.hold.ticketTypeId, name: l.hold.ticketType.name, ...l.q, ticketTotalCents: l.q.totalCents - l.q.donationCents, feeCents: l.feeCents, amountCents: l.amountCents };
  }

  /** Prices for a cart with an optional promo code, before the orders exist (POST /quote/cart). */
  async quoteCart(input: { holdIds: string[]; promoCode?: string; protection?: boolean; donationCents?: number }) {
    const holds = await this.cartHolds(input.holdIds);
    const { lines, totals, promo } = await this.priceCart(holds, input);
    return { promo, ...totals, lines: lines.map((l) => this.cartLineView(l)) };
  }

  /**
   * Checks out a cart (POST /orders/cart): one order per line, all with the cart's id (`groupId`, CRT-…), paid with a
   * single payment for the total. The cart id stands in for an order id at the payment provider and on
   * GET /orders/:id, POST /orders/:id/verify and /pay. Gifts are bought one ticket type at a time.
   */
  async createCartOrder(input: { holdIds: string[]; email: string; name: string; promoCode?: string; protection?: boolean; donationCents?: number; returnTo?: 'app'; answers?: AnswerInput[] }, user: AuthUser | null, clientIp: string | null) {
    const now = new Date();
    const holds = await this.cartHolds(input.holdIds);
    if (holds.some((h) => h.order)) throw new ConflictException('An order already exists for these seats.');
    if (holds.some((h) => h.status !== 'ACTIVE' || h.expiresAt <= now)) throw new ConflictException('Your seats were released. Please pick them again.');
    const { lines, totals, promo } = await this.priceCart(holds, input);
    const event = holds[0].event;
    // The organizer's checkout questions; a per-ticket answer's number counts across the cart's lines, in order.
    const answers = checkAnswers(questionsOf(event.questions), input.answers, holds.map((h) => h.quantity));
    const since = new Date(now.getTime() - 10 * 60_000);
    const [sameEmail, sameIp] = await Promise.all([
      this.prisma.order.count({ where: { email: input.email, createdAt: { gte: since } } }),
      clientIp ? this.prisma.order.count({ where: { clientIp, createdAt: { gte: since } } }) : Promise.resolve(0),
    ]);
    // One fraud check for the whole cart (its total and ticket count), flagged on the first order.
    const risk = scoreOrder({
      email: input.email,
      totalCents: this.fx.convert(totals.totalCents, event.currency, 'USD'),
      quantity: totals.quantity,
      maxPerOrder: holds.reduce((n, h) => n + h.ticketType.maxPerOrder, 0),
      recentOrdersSameEmail: sameEmail + 1,
      recentOrdersSameIp: sameIp + 1,
      secondsToCheckout: (now.getTime() - Math.min(...holds.map((h) => h.createdAt.getTime()))) / 1000,
    });

    const groupId = cartCode();
    const currency: Currency = isCurrency(event.currency) ? event.currency : 'USD';
    const free = totals.totalCents === 0;
    const provider = free ? null : this.payments.forCurrency(currency);
    const venue = event.venueId ? await this.prisma.venue.findUnique({ where: { id: event.venueId }, select: { name: true, city: true } }) : null;
    const orderIds = lines.map(() => orderCode());
    await this.prisma.$transaction(
      lines.map((l, i) =>
        this.prisma.order.create({
          data: {
            id: orderIds[i],
            groupId,
            // one transaction shares one clock: keep the lines in the order they were picked
            createdAt: new Date(now.getTime() + i),
            eventId: l.hold.eventId,
            ticketTypeId: l.hold.ticketTypeId,
            holdId: l.hold.id,
            buyerId: user?.id ?? null,
            email: input.email,
            buyerName: input.name.trim(),
            quantity: l.hold.quantity,
            unitCents: l.q.unitCents,
            subtotalCents: l.q.subtotalCents,
            discountCents: l.q.discountCents,
            protectionCents: l.q.protectionCents,
            totalCents: l.q.totalCents,
            donationCents: l.q.donationCents,
            donationCause: l.q.donationCents > 0 ? event.donationCause : null,
            promoCode: l.promo?.code ?? null,
            currency,
            provider: provider?.name ?? 'free',
            clientIp,
            snapshot: purchaseSnapshot(event, l.hold.ticketType, venue, event.dates, l.q.unitCents),
            ...(answers[i] ? { answers: answers[i]! } : {}),
          },
        }),
      ),
    );
    const holdExpiresAt = new Date(Math.min(...holds.map((h) => h.expiresAt.getTime())));
    const answer = { groupId, orderId: groupId, orderIds, currency, holdExpiresAt, promo, ...totals, lines: lines.map((l, i) => ({ orderId: orderIds[i], ...this.cartLineView(l) })) };

    if (!provider) {
      const done = await this.fulfilGroup(groupId);
      return { ...answer, status: done.status, provider: 'free' as const, clientSecret: null, redirectUrl: null };
    }
    let pay;
    try {
      // The organizer's share of every line (and the whole donation) settles to their Paystack subaccount.
      const share = lines.reduce((n, l) => n + Math.max(0, organizerNet(l.q.unitCents, event.feeMode, config.organizerFeePermille) * l.q.quantity - l.q.discountCents), 0) + totals.donationCents;
      pay = await provider.createPayment({
        orderId: groupId,
        amountCents: totals.totalCents,
        currency,
        email: input.email,
        description: `${lines.map((l) => `${l.q.quantity} × ${l.hold.ticketType.name}`).join(', ')} — ${event.title}`.slice(0, 240),
        returnTo: input.returnTo,
        ...(provider.name === 'paystack' ? await this.paystackSplitFor(event.orgId, currency, share, totals.totalCents) : {}),
      });
    } catch (e) {
      // The payment couldn't be started: the unpaid orders go, so the holds can be checked out again.
      await this.prisma.order.deleteMany({ where: { groupId, status: 'PENDING' } });
      throw e;
    }
    await this.prisma.order.updateMany({ where: { groupId }, data: { paymentRef: pay.paymentRef } });
    if (risk.score >= FRAUD_FLAG_THRESHOLD) await this.prisma.fraudFlag.create({ data: { orderId: orderIds[0], score: risk.score, reasons: risk.reasons } }).catch(() => undefined);
    return { ...answer, status: 'PENDING' as const, provider: provider.name, clientSecret: pay.clientSecret ?? null, redirectUrl: pay.redirectUrl ?? null };
  }

  /** A cart as one thing: its orders (each as GET /orders/:id shows it), every ticket, and the totals. */
  async groupView(groupId: string) {
    const rows = await this.prisma.order.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!rows.length) throw new NotFoundException('Order not found.');
    const orders = await Promise.all(rows.map((r) => this.orderView(r.id)));
    const first = orders[0];
    const sum = (f: (o: (typeof orders)[number]) => number) => orders.reduce((n, o) => n + f(o), 0);
    // Paid once every line that still stands is paid; a line whose seats were lost was refunded on its own.
    const live = orders.filter((o) => o.status !== 'CANCELLED');
    const status = !live.length ? ('CANCELLED' as const) : live.some((o) => o.status === 'PENDING') ? ('PENDING' as const) : live.every((o) => o.status === 'PAID') ? ('PAID' as const) : live[0].status;
    return {
      ...first,
      id: groupId,
      groupId,
      status,
      quantity: sum((o) => (o.status === 'CANCELLED' ? 0 : o.quantity)),
      subtotalCents: sum((o) => o.subtotalCents),
      discountCents: sum((o) => o.discountCents),
      protectionCents: sum((o) => o.protectionCents),
      donationCents: sum((o) => o.donationCents),
      totalCents: sum((o) => o.totalCents),
      refundedCents: sum((o) => o.refundedCents),
      tickets: orders.flatMap((o) => o.tickets),
      orders,
      // lines that couldn't be completed (seats gone, date cancelled) and were refunded on their own
      refundedOrders: orders.filter((o) => o.status === 'CANCELLED').map((o) => o.id),
    };
  }

  /**
   * Marks every order of a cart paid and issues its tickets (see `fulfil`; safe to call again). A line that can't be
   * completed (its seats went after the hold ran out, its date was cancelled) is refunded on its own and the rest go
   * ahead. One receipt for the whole cart.
   */
  async fulfilGroup(groupId: string) {
    const rows = await this.prisma.order.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!rows.length) throw new NotFoundException('Order not found.');
    const fresh: string[] = [];
    let failed: unknown = null;
    for (const r of rows) {
      try {
        await this.fulfil(r.id, fresh);
      } catch (e) {
        // A line refunded on its own (ConflictException) doesn't stop the others; anything else is retried later.
        if (!(e instanceof ConflictException)) failed ??= e;
      }
    }
    if (fresh.length) {
      void this.sendCartReceipt(groupId, fresh).catch((e) => this.log.warn(`Receipt for ${groupId}: ${(e as Error).message}`));
      void this.notices.orderPaid(fresh[0]);
      for (const id of fresh) void this.notices.newSale(id);
    }
    if (failed) throw failed;
    const view = await this.groupView(groupId);
    if (view.status === 'CANCELLED') throw new ConflictException('These tickets were no longer available when your payment finished. You have been refunded in full.');
    return view;
  }

  /** A cart's payment, checked with the provider (the website asks after the fan pays; the webhooks do the same). */
  private async verifyGroup(groupId: string) {
    const orders = await this.prisma.order.findMany({ where: { groupId }, select: { id: true, status: true, provider: true, paymentRef: true, totalCents: true, currency: true } });
    if (!orders.length) throw new NotFoundException('Order not found.');
    if (!orders.some((o) => o.status === 'PENDING')) return this.groupView(groupId);
    const total = orders.reduce((n, o) => n + o.totalCents, 0);
    const { provider, paymentRef, currency } = orders[0];
    const mismatch = (paid: number, cur: string) => {
      this.log.error(`${provider} amount mismatch on ${groupId}: paid ${paid} ${cur}, expected ${total} ${currency}`);
      return new BadRequestException('The payment amount doesn’t match the order. Our team has been alerted.');
    };
    if (provider === 'stripe') {
      const stripe = this.payments.stripe;
      if (!stripe || !paymentRef) throw new BadRequestException('Card payments aren’t configured on this server.');
      const pi = await stripe.paymentIntents.retrieve(paymentRef);
      if (pi.metadata?.orderId !== groupId) throw new BadRequestException('That payment belongs to a different order.');
      if (pi.status !== 'succeeded') return { ...(await this.groupView(groupId)), paymentStatus: pi.status };
      if (pi.amount !== total || pi.currency.toUpperCase() !== currency) throw mismatch(pi.amount, pi.currency);
      return this.fulfilGroup(groupId);
    }
    if (provider !== 'paystack') throw new BadRequestException('This order isn’t paid through Paystack.');
    if (!this.payments.paystack) throw new BadRequestException('Paystack isn’t configured on this server.');
    const t = await this.payments.paystack.verify(paymentRef ?? groupId);
    if (t.status !== 'success') return { ...(await this.groupView(groupId)), paymentStatus: t.status };
    if (t.amount !== total || t.currency !== currency) throw mismatch(t.amount, t.currency);
    return this.fulfilGroup(groupId);
  }

  /** One email for a cart: every line that was paid, the total, when and where. */
  private async sendCartReceipt(groupId: string, orderIds: string[]) {
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      orderBy: { createdAt: 'asc' },
      include: { event: { select: { title: true, startsAt: true, online: true, dateMode: true, dates: true, venue: { select: { name: true, city: true } } } }, ticketType: { select: { name: true, eventDateId: true, validDateIds: true } } },
    });
    if (!orders.length) return;
    const o = orders[0];
    const total = orders.reduce((n, x) => n + x.totalCents, 0);
    const donation = orders.reduce((n, x) => n + x.donationCents, 0);
    const where = o.event.online ? 'Online' : o.event.venue ? `${o.event.venue.name}, ${o.event.venue.city}` : '';
    const count = orders.reduce((n, x) => n + x.quantity, 0);
    const { html, text } = render({
      preheader: `${count} tickets for ${o.event.title}. Order ${groupId}.`,
      heading: `You're going to ${o.event.title}`,
      highlight: { label: `Order ${groupId} · ${total > 0 ? 'paid' : 'confirmed'}`, value: total > 0 ? formatMoney(total, o.currency) : 'Free' },
      paragraphs: [
        ...orders.map((x) => {
          const tickets = x.totalCents - x.donationCents;
          // Each line's own date (multiple dates) or days (a multi-day pass), when lines differ.
          const when = o.event.dateMode === 'SINGLE' ? '' : ` · ${whenText(x.event.dateMode, x.event, x.ticketType, x.event.dates)}`;
          return `${x.quantity} × ${x.ticketType.name}: ${tickets > 0 ? formatMoney(tickets, x.currency) : 'Free'}${when}`;
        }),
        ...(donation > 0
          ? [`Donation to ${o.donationCause ?? 'the organizer’s cause'}: ${formatMoney(donation, o.currency)}. Thank you! Omoshow collects donations on the organizer's behalf; the organizer is responsible for passing them to the cause. Donations aren’t refunded if a ticket doesn’t scan.`]
          : []),
        `${o.event.dateMode === 'SINGLE' ? `${whenText(o.event.dateMode, o.event, o.ticketType, o.event.dates)}${where ? ' · ' : ''}` : ''}${where}`,
        'Your tickets are in your Omoshow account. The QR code refreshes every few seconds, so screenshots won’t work at the door.',
      ].filter(Boolean),
      cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
      footer: 'You got this email because you bought tickets on Omoshow. Need help?',
      footerLink: { label: 'Visit the help centre', url: `${config.webUrl}/help` },
    });
    await this.mail.send('order.receipt', { to: o.email, subject: `Your tickets: ${o.event.title} (${groupId})`, html, text });
  }

  /** Development only: completes a mock payment. */
  async payMock(orderId: string) {
    if (isCartCode(orderId)) {
      const o = await this.prisma.order.findFirst({ where: { groupId: orderId }, select: { provider: true } });
      if (!o) throw new NotFoundException('Order not found.');
      if (o.provider === 'free') return this.fulfilGroup(orderId);
      if (o.provider !== 'mock') throw new ForbiddenException('This order is paid through a payment provider.');
      if (config.isProduction) throw new ForbiddenException('Test payments are switched off on this site.');
      return this.fulfilGroup(orderId);
    }
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
    if (isCartCode(orderId)) return this.verifyGroup(orderId);
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

  async fulfil(orderId: string, cart?: string[]) {
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
        // A promo code is used once per checkout: a cart's later lines don't count again. (updateMany: a code deleted
        // while the fan was paying mustn't stop a paid order.)
        const counted = order.promoCode && order.groupId ? await tx.order.count({ where: { groupId: order.groupId, promoCode: order.promoCode, status: 'PAID' } }) : 0;
        if (order.promoCode && !counted) {
          await tx.promo.updateMany({ where: { eventId: order.eventId, code: order.promoCode }, data: { used: { increment: 1 } } });
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
    // Part of a cart: the cart sends one receipt and the pushes for all its lines (fulfilGroup).
    if (result.fresh && cart) {
      cart.push(orderId);
      return this.orderView(orderId);
    }
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

  /** The one answer to "Can't find my order?", whatever the email. */
  static readonly FIND_REPLY = { message: 'If we have orders for that email, we’ve sent the list there. Check your inbox, and your spam folder too.' };
  /** Order lists sent per email in the last hour (in this process), so the form can't be used to flood an inbox. */
  private readonly findSent = new Map<string, number[]>();

  findOrders(email: string) {
    void this.sendOrderList(email).catch((e) => this.log.warn(`Order list email: ${(e as Error).message}`));
    return CheckoutService.FIND_REPLY;
  }

  private async sendOrderList(email: string) {
    const now = Date.now();
    const recent = (this.findSent.get(email) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= FIND_PER_EMAIL_PER_HOUR) return;
    const orders = await this.prisma.order.findMany({
      where: { email, OR: [{ status: { in: ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }, { status: 'CANCELLED', paidAt: { not: null } }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        quantity: true,
        event: { select: { title: true, startsAt: true, online: true, dateMode: true, dates: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { name: true, eventDateId: true, validDateIds: true } },
      },
    });
    if (!orders.length) return;
    recent.push(now);
    this.findSent.set(email, recent);
    if (this.findSent.size > 5000) for (const [k, v] of this.findSent) if (v.every((t) => now - t >= 3600_000)) this.findSent.delete(k);

    const account = await this.prisma.user.findUnique({ where: { email }, select: { suspendedAt: true } });
    const status = (s: string) => (s === 'REFUNDED' ? ' · refunded' : s === 'PARTIALLY_REFUNDED' ? ' · partly refunded' : s === 'CANCELLED' ? ' · cancelled' : '');
    const lines = orders.map((o) => {
      const where = o.event.online ? 'Online' : o.event.venue ? o.event.venue.city : '';
      return `${o.event.title}: ${o.quantity} × ${o.ticketType.name}, ${whenText(o.event.dateMode, o.event, o.ticketType, o.event.dates)}${where ? ` · ${where}` : ''}. Order ${o.id}${status(o.status)}.`;
    });
    const has = account && !account.suspendedAt;
    const { html, text } = render({
      preheader: `${orders.length} ${orders.length === 1 ? 'order' : 'orders'} bought with ${email}.`,
      heading: 'Your Omoshow orders',
      paragraphs: [
        `Here ${orders.length === 1 ? 'is the order' : `are the ${orders.length} orders`} bought with ${email}${orders.length === 20 ? ' (the 20 newest)' : ''}:`,
        ...lines,
        has
          ? 'Sign in with this email to see your tickets and show the QR code at the door.'
          : `Sign up with this same email (${email}) and your tickets move into your new account, ready for the door.`,
        'If you didn’t ask for this list, you can ignore this email.',
      ],
      cta: { label: has ? 'Sign in to see my tickets' : 'Get my tickets', url: `${config.webUrl}/signin?next=%2Ftickets` },
      footer: 'You’re getting this because someone asked Omoshow to resend the orders for this email. Need help?',
      footerLink: { label: 'Visit the help centre', url: `${config.webUrl}/help` },
    });
    await this.mail.send('order.lookup', { to: email, subject: 'Your Omoshow orders', html, text });
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
    const cart = isCartCode(orderId);
    const o = cart
      ? await this.prisma.order.findFirst({ where: { groupId: orderId }, select: { buyerId: true, email: true } })
      : await this.prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true, email: true } });
    const allowed = o && ((user && (o.buyerId === user.id || user.roles.includes('ADMIN'))) || (email && email.trim().toLowerCase() === o.email));
    if (!allowed) throw new NotFoundException('Order not found.');
    // A cart: its orders together (refund requests are made per order).
    if (cart) return { ...(await this.groupView(orderId)), refundRequests: [] };
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
        if (isCartCode(orderId)) await this.fulfilGroup(orderId);
        else await this.fulfil(orderId);
      } catch (e) {
        this.log.warn(`Fulfilment for ${orderId} ended with: ${(e as Error).message}`);
      }
    } else if (type === 'payment_intent.canceled') {
      // Only a cancelled payment ends the order. A declined card (payment_intent.payment_failed) doesn't: the fan can
      // try again on the same payment while the seats are held, and that payment must still find its order.
      const orders = await this.prisma.order.findMany({ where: isCartCode(orderId) ? { groupId: orderId } : { id: orderId }, select: { id: true, status: true, holdId: true } });
      for (const o of orders) {
        if (o.status !== 'PENDING') continue;
        await this.prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
        if (o.holdId) await this.prisma.hold.updateMany({ where: { id: o.holdId, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      }
    }
  }
}
