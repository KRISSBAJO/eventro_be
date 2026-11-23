import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InventoryService } from '../common/inventory.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { orderCode, ticketCode } from '../domain/codes';
import { quote } from '../domain/money';
import { FRAUD_FLAG_THRESHOLD, scoreOrder } from '../domain/fraud';
import { assignSeats, sectionCapacity, type SeatMap } from '../domain/seatmap';
import { Payments } from './payments';
import type { AuthUser } from '../common/auth';

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

      return tx.hold.create({
        data: {
          eventId: ev.id,
          ticketTypeId: tt.id,
          sectionId: input.sectionId ?? null,
          quantity: input.quantity,
          userId: user?.id ?? null,
          expiresAt: new Date(now.getTime() + config.holdMinutes * 60_000),
        },
        select: { id: true, quantity: true, expiresAt: true, sectionId: true, ticketTypeId: true },
      });
    });
  }

  async releaseHold(id: string) {
    const { count } = await this.prisma.hold.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
    if (!count) throw new NotFoundException('Hold not found or already used.');
    return { released: true };
  }

  /* ---------- orders ---------- */

  async createOrder(
    input: { holdId: string; email: string; name: string; protection?: boolean; promoCode?: string },
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

    const q = quote(hold.ticketType.priceCents, hold.quantity, promo?.percent ?? null, !!input.protection);
    const since = new Date(now.getTime() - 10 * 60_000);
    const [sameEmail, sameIp] = await Promise.all([
      this.prisma.order.count({ where: { email: input.email, createdAt: { gte: since } } }),
      clientIp ? this.prisma.order.count({ where: { clientIp, createdAt: { gte: since } } }) : Promise.resolve(0),
    ]);
    const risk = scoreOrder({
      email: input.email,
      totalCents: q.totalCents,
      quantity: hold.quantity,
      maxPerOrder: hold.ticketType.maxPerOrder,
      recentOrdersSameEmail: sameEmail + 1,
      recentOrdersSameIp: sameIp + 1,
      secondsToCheckout: (now.getTime() - hold.createdAt.getTime()) / 1000,
    });

    const id = orderCode();
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
        provider: this.payments.provider.name,
        clientIp,
        ...(risk.score >= FRAUD_FLAG_THRESHOLD ? { fraudFlag: { create: { score: risk.score, reasons: risk.reasons } } } : {}),
      },
    });

    const pay = await this.payments.provider.createPayment({
      orderId: id,
      amountCents: q.totalCents,
      email: input.email,
      description: `${hold.quantity} × ${hold.ticketType.name} — ${hold.event.title}`,
    });
    await this.prisma.order.update({ where: { id }, data: { paymentRef: pay.paymentRef } });

    return {
      orderId: order.id,
      status: order.status,
      provider: this.payments.provider.name,
      clientSecret: pay.clientSecret,
      holdExpiresAt: hold.expiresAt,
      ...q,
    };
  }

  /** Development only: completes a mock payment. */
  async payMock(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    if (o.provider !== 'mock') throw new ForbiddenException('This order is paid through Stripe.');
    return this.fulfil(orderId);
  }

  /**
   * Marks an order paid and issues tickets. Safe to call more than once (webhook retries).
   * If the hold expired during payment and the seats are gone, the payment is refunded.
   */
  async fulfil(orderId: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({ where: { id: orderId }, include: { hold: true, event: true, ticketType: true } });
        if (!order) throw new NotFoundException('Order not found.');
        if (order.status !== 'PENDING') return { order, refund: false };
        await lockTicketType(tx, order.ticketTypeId);

        const now = new Date();
        const holdLive = order.hold?.status === 'ACTIVE';
        if (!holdLive || order.hold!.expiresAt <= now) {
          // Seats were released: only proceed if they're still free.
          const left = await this.inventory.availableForType(tx, order.ticketTypeId, now);
          if (left < order.quantity) {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
            if (order.hold) await tx.hold.update({ where: { id: order.hold.id }, data: { status: 'EXPIRED' } });
            return { order, refund: true };
          }
        }

        const seats = await this.pickSeats(tx, order.eventId, order.event.seatMap as SeatMap | null, order.ticketTypeId, order.hold?.sectionId ?? null, order.quantity);
        const owner = order.buyerId ?? (await tx.user.findUnique({ where: { email: order.email }, select: { id: true } }))?.id ?? null;

        await tx.ticket.createMany({
          data: seats.map((s, i) => ({
            id: ticketCode(order.id, i),
            orderId: order.id,
            eventId: order.eventId,
            ticketTypeId: order.ticketTypeId,
            ownerId: owner,
            holderName: order.buyerName,
            holderEmail: order.email,
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
        return { order: paid, refund: false };
      },
      { timeout: 20_000 },
    );

    if (result.refund && result.order.paymentRef) {
      await this.payments.provider.refund(result.order.paymentRef, result.order.totalCents);
      await this.audit.log(null, 'order.auto_refund', 'Order', orderId, { reason: 'seats no longer available after hold expired' });
      throw new ConflictException('Your seats were released before payment finished. You have been refunded in full.');
    }
    return this.orderView(orderId);
  }

  /** Best-available seats for a paid order. GA sections and events without a map get no seat numbers. */
  private async pickSeats(tx: Tx, eventId: string, map: SeatMap | null, ticketTypeId: string, sectionId: string | null, qty: number) {
    const sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === ticketTypeId && (!sectionId || s.id === sectionId));
    if (!sections.length) return Array.from({ length: qty }, () => ({ section: null, row: null, seat: null }));

    const taken = await tx.ticket.findMany({
      where: { eventId, section: { in: sections.map((s) => s.id) }, status: { not: 'VOID' } },
      select: { section: true, row: true, seat: true },
    });
    for (const s of sections) {
      const inSection = taken.filter((t) => t.section === s.id);
      if (s.seating === 'ga') {
        if (sectionCapacity(s) - inSection.length >= qty) return Array.from({ length: qty }, () => ({ section: s.id, row: null, seat: null }));
        continue;
      }
      const picked = assignSeats(s, new Set(inSection.map((t) => `${t.row}:${t.seat}`)), qty);
      if (picked) return picked.map((p) => ({ section: s.id, row: p.row, seat: p.seat }));
    }
    throw new ConflictException('Not enough seats together. Try fewer tickets or another section.');
  }

  async orderView(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { slug: true, title: true, startsAt: true, venue: { select: { name: true, city: true } } } },
        ticketType: { select: { name: true } },
        tickets: { select: { id: true, section: true, row: true, seat: true, status: true, holderName: true }, orderBy: { id: 'asc' } },
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
