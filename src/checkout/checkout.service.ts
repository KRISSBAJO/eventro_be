import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InventoryService } from '../common/inventory.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { orderCode, ticketCode } from '../domain/codes';
import { organizerNet, quote } from '../domain/money';
import { FRAUD_FLAG_THRESHOLD, scoreOrder } from '../domain/fraud';
import { pickFromSections, type SeatMap, type SeatPick } from '../domain/seatmap';
import { Payments } from './payments';
import { FxService } from '../fx/fx.module';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { GiftService, type GiftInput } from '../gifts/gifts.module';
import { ResaleService } from '../resale/resale.module';
import { isCurrency, type Currency } from '../domain/currency';
import type { AuthUser } from '../common/auth';
import { paystackCountryFor } from '../organizer/payout-accounts';

type Tx = Prisma.TransactionClient;

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
  ) {}

  /* ---------- holds ---------- */

  async createHold(input: { ticketTypeId: string; quantity: number; sectionId?: string }, user: AuthUser | null) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockTicketType(tx, input.ticketTypeId);
      const tt = await tx.ticketType.findUnique({ where: { id: input.ticketTypeId }, include: { event: true } });
      if (!tt) throw new NotFoundException('Ticket type not found.');
      const ev = tt.event;
      if (ev.status !== 'PUBLISHED') throw new BadRequestException('This event is not on sale.');
      if (ev.salesPaused) throw new ConflictException('Sales are paused by the organizer.');
      if (ev.startsAt <= now) throw new BadRequestException('This event has already started.');
      if ((tt.salesStart && tt.salesStart > now) || (tt.salesEnd && tt.salesEnd < now)) throw new BadRequestException('These tickets are not on sale right now.');
      if (input.quantity > tt.maxPerOrder) throw new BadRequestException(`You can buy up to ${tt.maxPerOrder} of these per order.`);

      const left = await this.inventory.availableForType(tx, tt.id, now);
      if (left < input.quantity) throw new ConflictException(left ? `Only ${left} left.` : 'Sold out.');

      if (input.sectionId) {
        const map = ev.seatMap as SeatMap | null;
        const section = map?.sections.find((s) => s.id === input.sectionId);
        if (!section || section.ticketTypeId !== tt.id) throw new BadRequestException('That section isn’t sold with this ticket type.');
        const sec = await this.inventory.availabilityForSections(tx, ev.id, { ...map!, sections: [section] }, now);
        const n = sec.get(section.id) ?? 0;
        if (n < input.quantity) throw new ConflictException(n ? `Only ${n} left in ${section.label}.` : `${section.label} is sold out.`);
      }

      // On a seat map the hold reserves exact seats, so the group is guaranteed to sit together.
      const map = ev.seatMap as SeatMap | null;
      const sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === tt.id && (!input.sectionId || s.id === input.sectionId));
      let seats: SeatPick[] | null = null;
      if (sections.length) {
        const inUse = await this.inventory.seatsInUse(tx, ev.id, sections.map((s) => s.id), now);
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
          userId: user?.id ?? null,
          expiresAt: new Date(now.getTime() + config.holdMinutes * 60_000),
        },
        select: { id: true, quantity: true, expiresAt: true, sectionId: true, ticketTypeId: true, seats: true },
      });
    });
  }

  /** A hold with what the checkout page needs to show. The id is unguessable, so it acts as the key. */
  async getHold(id: string) {
    const h = await this.prisma.hold.findUnique({
      where: { id },
      include: {
        ticketType: { select: { id: true, name: true, description: true, priceCents: true } },
        event: { select: { slug: true, title: true, subtitle: true, category: true, currency: true, timezone: true, imageUrl: true, startsAt: true, doorsAt: true, description: true, seatMap: true, venue: { select: { name: true, city: true, address: true } } } },
        order: { select: { id: true, status: true } },
      },
    });
    if (!h) throw new NotFoundException('Hold not found.');
    const { seatMap, ...event } = h.event;
    const section = (seatMap as SeatMap | null)?.sections.find((s) => s.id === h.sectionId);
    return {
      id: h.id,
      status: h.status === 'ACTIVE' && h.expiresAt <= new Date() ? 'EXPIRED' : h.status,
      quantity: h.quantity,
      expiresAt: h.expiresAt,
      section: section ? { id: section.id, label: section.label, level: section.level ?? null, seating: section.seating } : null,
      seats: (h.seats as SeatPick[] | null) ?? [],
      ticketType: h.ticketType,
      event,
      order: h.order,
    };
  }

  /** Prices for a hold with an optional promo code, before an order exists. */
  async quoteHold(input: { holdId: string; promoCode?: string; protection?: boolean }) {
    const hold = await this.prisma.hold.findUnique({ where: { id: input.holdId }, include: { ticketType: true } });
    if (!hold) throw new NotFoundException('Hold not found.');
    let promo: { code: string; percent: number } | null = null;
    if (input.promoCode) {
      const p = await this.prisma.promo.findUnique({ where: { eventId_code: { eventId: hold.eventId, code: input.promoCode.trim().toUpperCase() } } });
      if (!p || !p.active || (p.limit !== null && p.used >= p.limit)) throw new BadRequestException('That promo code isn’t valid for this event.');
      promo = { code: p.code, percent: p.percent };
    }
    return { promo, ...quote(hold.ticketType.priceCents, hold.quantity, promo?.percent ?? null, !!input.protection) };
  }

  async releaseHold(id: string) {
    const { count } = await this.prisma.hold.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
    if (!count) throw new NotFoundException('Hold not found or already used.');
    return { released: true };
  }

  /* ---------- orders ---------- */

  /**
   * Paystack split for organizers paid through a Paystack subaccount: their share of the tickets (after Eventro's fee
   * and any discount) settles straight to their bank; Eventro keeps the rest (fee and ticket protection).
   * No split while payouts are on hold after a bank change, or if the sale is in a different currency than their bank.
   */
  private async paystackSplit(orgId: string, currency: string, q: { unitCents: number; quantity: number; discountCents: number; totalCents: number }, feeMode: 'BUYER' | 'ORGANIZER') {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { payoutProvider: true, paystackSubaccount: true, bankCountry: true, payoutHoldUntil: true } });
    if (org?.payoutProvider !== 'paystack' || !org.paystackSubaccount) return {};
    if (org.payoutHoldUntil && org.payoutHoldUntil > new Date()) return {};
    if (paystackCountryFor(currency)?.code !== org.bankCountry) return {};
    const share = Math.max(0, organizerNet(q.unitCents, feeMode, config.organizerFeePermille) * q.quantity - q.discountCents);
    return { split: { subaccount: org.paystackSubaccount, platformCents: Math.max(0, q.totalCents - share) } };
  }

  async createOrder(
    input: { holdId: string; email: string; name: string; protection?: boolean; promoCode?: string; gift?: GiftInput },
    user: AuthUser | null,
    clientIp: string | null,
  ) {
    const now = new Date();
    const hold = await this.prisma.hold.findUnique({ where: { id: input.holdId }, include: { ticketType: true, event: true, order: true } });
    if (!hold) throw new NotFoundException('Hold not found.');
    if (hold.order) throw new ConflictException('An order already exists for these seats.');
    if (hold.status !== 'ACTIVE' || hold.expiresAt <= now) throw new ConflictException('Your seats were released. Please pick them again.');

    let promo: { code: string; percent: number } | null = null;
    if (input.promoCode) {
      const p = await this.prisma.promo.findUnique({ where: { eventId_code: { eventId: hold.eventId, code: input.promoCode.trim().toUpperCase() } } });
      if (!p || !p.active || (p.limit !== null && p.used >= p.limit)) throw new BadRequestException('That promo code isn’t valid for this event.');
      promo = { code: p.code, percent: p.percent };
    }

    const gift = input.gift ? this.gifts.validate(input.gift, input.email, hold.event.startsAt) : null;
    const q = quote(hold.ticketType.priceCents, hold.quantity, promo?.percent ?? null, !!input.protection);
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
    const provider = this.payments.forCurrency(currency);
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
        promoCode: promo?.code ?? null,
        currency,
        provider: provider.name,
        clientIp,
        ...(risk.score >= FRAUD_FLAG_THRESHOLD ? { fraudFlag: { create: { score: risk.score, reasons: risk.reasons } } } : {}),
        ...(gift ? { gift: { create: gift } } : {}),
      },
    });

    const pay = await provider.createPayment({
      orderId: id,
      amountCents: q.totalCents,
      currency,
      email: input.email,
      description: `${hold.quantity} × ${hold.ticketType.name} — ${hold.event.title}`,
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
    };
  }

  /** Pays for a fan-resale listing the buyer is holding (POST /resale/:id/hold gave them the key). */
  async createResaleOrder(listingId: string, input: { holdKey: string; email: string; name: string }, user: AuthUser | null, clientIp: string | null) {
    const l = await this.prisma.resaleListing.findUnique({ where: { id: listingId }, include: { event: true, ticket: { include: { ticketType: true } }, order: true } });
    if (!l || l.status !== 'HELD' || l.heldBy !== input.holdKey || !l.heldUntil || l.heldUntil <= new Date()) {
      throw new ConflictException('Your hold on that ticket ran out. Pick it again.');
    }
    if (l.order) throw new ConflictException('An order already exists for this ticket.');
    if (user?.id === l.sellerId) throw new BadRequestException('That’s your own listing.');
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
        totalCents: l.priceCents,
        currency,
        provider: provider.name,
        clientIp,
        resaleListingId: l.id,
      },
    });
    const pay = await provider.createPayment({ orderId: id, amountCents: l.priceCents, currency, email: input.email, description: `Resale: ${l.ticket.ticketType.name} — ${l.event.title}` });
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
      totalCents: l.priceCents,
    };
  }

  /** Development only: completes a mock payment. */
  async payMock(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
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
        const order = await tx.order.findUnique({ where: { id: orderId }, include: { hold: true, event: true, ticketType: true, gift: true } });
        if (!order) throw new NotFoundException('Order not found.');
        if (order.status !== 'PENDING') return { order, refund: false, fresh: false };
        // Paid after the event was cancelled (the payment was already under way): refund it instead of issuing tickets.
        if (order.event.status === 'CANCELLED') {
          await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
          if (order.hold?.status === 'ACTIVE') await tx.hold.update({ where: { id: order.hold.id }, data: { status: 'RELEASED' } });
          return { order, refund: true, fresh: false, eventCancelled: true };
        }

        if (order.resaleListingId) {
          // Fan resale: the seller's ticket is cancelled and the buyer gets a new ticket for the same seat.
          await tx.$queryRaw`SELECT id FROM "ResaleListing" WHERE id = ${order.resaleListingId} FOR UPDATE`;
          const l = await tx.resaleListing.findUnique({ where: { id: order.resaleListingId }, include: { ticket: true } });
          if (!l || l.status !== 'HELD' || l.ticket.status !== 'LISTED') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
            return { order, refund: true, fresh: false };
          }
          const old = l.ticket;
          const owner = order.buyerId ?? (await tx.user.findUnique({ where: { email: order.email }, select: { id: true } }))?.id ?? null;
          await tx.ticket.update({ where: { id: old.id }, data: { status: 'VOID', listCents: null, resoldAt: new Date(), section: null, row: null, seat: null } });
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
              // a day after the event (event times are wall-clock UTC, so a day covers the time zone)
              payoutAvailableAt: new Date(order.event.startsAt.getTime() + 86_400_000),
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
        const seats = held?.length === order.quantity ? held : await this.pickSeats(tx, order.eventId, order.event.seatMap as SeatMap | null, order.ticketTypeId, order.hold?.sectionId ?? null, order.quantity, now);
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
    }
    return this.orderView(orderId);
  }

  private async sendReceipt(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { title: true, startsAt: true, online: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { name: true } },
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
    const when = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(o.event.startsAt);
    const where = o.event.online ? 'Online' : o.event.venue ? `${o.event.venue.name}, ${o.event.venue.city}` : '';
    const seats = o.tickets.filter((t) => t.seat !== null).map((t) => `${t.section} · Row ${t.row} · Seat ${t.seat}`);
    const { html, text } = render({
      preheader: `${o.quantity} × ${o.ticketType.name} for ${o.event.title}. Order ${o.id}.`,
      heading: `You're going to ${o.event.title}`,
      highlight: { label: `Order ${o.id} · paid`, value: formatMoney(o.totalCents, o.currency) },
      paragraphs: [
        `${o.quantity} × ${o.ticketType.name}`,
        `${when}${where ? ` · ${where}` : ''}`,
        ...(seats.length ? [`Seats: ${seats.join('; ')}`] : []),
        giftLine ?? 'Your tickets are in your Eventro account. The QR code refreshes every few seconds, so screenshots won’t work at the door.',
      ],
      cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
      footer: 'You got this email because you bought tickets on Eventro. Need help?',
      footerLink: { label: 'Visit the help centre', url: `${config.webUrl}/help` },
    });
    await this.mail.send('order.receipt', { to: o.email, subject: `Your tickets: ${o.event.title} (${o.id})`, html, text });
  }

  /** Best-available seats for a paid order. GA sections and events without a map get no seat numbers. */
  private async pickSeats(tx: Tx, eventId: string, map: SeatMap | null, ticketTypeId: string, sectionId: string | null, qty: number, now: Date): Promise<SeatPick[] | { section: null; row: null; seat: null }[]> {
    let sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === ticketTypeId && (!sectionId || s.id === sectionId));
    if (!sections.length && sectionId) sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === ticketTypeId);
    if (!sections.length) return Array.from({ length: qty }, () => ({ section: null, row: null, seat: null }));
    const inUse = await this.inventory.seatsInUse(tx, eventId, sections.map((s) => s.id), now);
    const picked = pickFromSections(sections, inUse, qty);
    if (!picked) throw new ConflictException('Not enough seats together. Try fewer tickets or another section.');
    return picked;
  }

  async orderView(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { slug: true, title: true, startsAt: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { name: true } },
        tickets: { select: { id: true, section: true, row: true, seat: true, status: true, holderName: true }, orderBy: { id: 'asc' } },
        gift: { select: { id: true, recipientName: true, recipientEmail: true, message: true, sendAt: true, sentAt: true, claimedAt: true } },
      },
    });
    if (!o) throw new NotFoundException('Order not found.');
    const { clientIp: _ip, paymentRef: _ref, ...safe } = o;
    return safe;
  }

  async getOrder(orderId: string, user: AuthUser | null, email?: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true, email: true } });
    const allowed = o && ((user && (o.buyerId === user.id || user.roles.includes('ADMIN'))) || (email && email.trim().toLowerCase() === o.email));
    if (!allowed) throw new NotFoundException('Order not found.');
    return this.orderView(orderId);
  }

  async requestRefund(orderId: string, user: AuthUser, reason: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o || (o.buyerId !== user.id && o.email !== user.email)) throw new NotFoundException('Order not found.');
    if (o.status !== 'PAID') throw new BadRequestException('Only paid orders can be refunded.');
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
