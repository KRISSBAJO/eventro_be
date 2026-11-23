import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/** Append-only record of sensitive actions (admin decisions, refunds, check-ins, payouts). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(actorId: string | null, action: string, entity: string, entityId: string, data?: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({ data: { actorId, action, entity, entityId, data } });
  }
}
