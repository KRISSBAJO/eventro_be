import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, Min } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { qrToken } from '../domain/qr';
import { permilleOf } from '../domain/money';
import { CurrentUser, type AuthUser } from '../common/auth';

export class TransferDto {
  @ApiProperty() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() email: string;
}

export class ListDto {
  @ApiProperty({ description: 'Resale price in cents' }) @IsInt() @Min(100) priceCents: number;
}

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  private async owned(id: string, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { ticketType: true, event: true } });
    if (!t || (t.ownerId !== user.id && t.holderEmail !== user.email)) throw new NotFoundException('Ticket not found.');
    return t;
  }

  async mine(user: AuthUser) {
    const tickets = await this.prisma.ticket.findMany({
      where: { OR: [{ ownerId: user.id }, { holderEmail: user.email }], status: { not: 'VOID' } },
      include: {
        ticketType: { select: { name: true } },
        event: { select: { slug: true, title: true, subtitle: true, startsAt: true, doorsAt: true, imageUrl: true, venue: { select: { name: true, address: true, city: true } } } },
      },
      orderBy: [{ event: { startsAt: 'asc' } }, { id: 'asc' }],
    });
    const incoming = await this.prisma.ticket.findMany({
      where: { transferTo: user.email, status: 'TRANSFER_PENDING' },
      select: { id: true, holderName: true, event: { select: { title: true, startsAt: true } }, ticketType: { select: { name: true } } },
    });
    return { tickets, incomingTransfers: incoming };
  }

  async qr(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (t.status !== 'ACTIVE') throw new BadRequestException(t.status === 'CHECKED_IN' ? 'This ticket has already been used.' : 'This ticket can’t be scanned right now.');
    return qrToken(config.qrSecret, t.id);
  }

  async transfer(id: string, user: AuthUser, email: string) {
    const t = await this.owned(id, user);
    if (email === user.email) throw new BadRequestException('That’s your own email.');
    if (t.status !== 'ACTIVE') throw new BadRequestException('Only active tickets can be transferred.');
    return this.prisma.ticket.update({ where: { id }, data: { status: 'TRANSFER_PENDING', transferTo: email } });
  }

  async cancelTransfer(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (t.status !== 'TRANSFER_PENDING') throw new BadRequestException('There’s no transfer to cancel.');
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ACTIVE', transferTo: null } });
  }

  async accept(id: string, user: AuthUser) {
    const { count } = await this.prisma.ticket.updateMany({
      where: { id, status: 'TRANSFER_PENDING', transferTo: user.email },
      data: { status: 'ACTIVE', transferTo: null, ownerId: user.id, holderEmail: user.email, holderName: user.name },
    });
    if (!count) throw new NotFoundException('Transfer not found.');
    return this.prisma.ticket.findUnique({ where: { id } });
  }

  async list(id: string, user: AuthUser, priceCents: number) {
    const t = await this.owned(id, user);
    if (t.status !== 'ACTIVE') throw new BadRequestException('Only active tickets can be listed.');
    if (priceCents > t.ticketType.priceCents * 3) throw new BadRequestException('Resale is capped at 3× face value.');
    const updated = await this.prisma.ticket.update({ where: { id }, data: { status: 'LISTED', listCents: priceCents } });
    return { ...updated, payoutCents: priceCents - permilleOf(priceCents, config.resaleFeePermille) };
  }

  async unlist(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (t.status !== 'LISTED') throw new BadRequestException('This ticket isn’t listed.');
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ACTIVE', listCents: null } });
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('me/tickets')
  mine(@CurrentUser() user: AuthUser) {
    return this.tickets.mine(user);
  }

  /** Rotating QR token for the door. Refresh when `expiresInMs` runs out. */
  @Get('tickets/:id/qr')
  qr(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.qr(id, user);
  }

  @Post('tickets/:id/transfer')
  @HttpCode(200)
  transfer(@Param('id') id: string, @Body() dto: TransferDto, @CurrentUser() user: AuthUser) {
    return this.tickets.transfer(id, user, dto.email);
  }

  @Delete('tickets/:id/transfer')
  cancelTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.cancelTransfer(id, user);
  }

  @Post('tickets/:id/accept')
  @HttpCode(200)
  accept(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.accept(id, user);
  }

  @Post('tickets/:id/listing')
  @HttpCode(200)
  list(@Param('id') id: string, @Body() dto: ListDto, @CurrentUser() user: AuthUser) {
    return this.tickets.list(id, user, dto.priceCents);
  }

  @Delete('tickets/:id/listing')
  unlist(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.unlist(id, user);
  }
}

@Module({ controllers: [TicketsController], providers: [TicketsService] })
export class TicketsModule {}
