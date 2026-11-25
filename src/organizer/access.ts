import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { MemberRole } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';

/** Org admins and managers: edit events, issue and revoke comps, keep the guest list. */
export const EDIT_ROLES: MemberRole[] = ['ADMIN', 'MANAGER'];
/** Door staff and up: view comps and the guest list, check people in. */
export const DOOR_ROLES: MemberRole[] = ['ADMIN', 'MANAGER', 'DOOR'];

/** The event, if this account is an active member of its organization with one of `roles` (same rules as OrganizerService). */
export async function eventForRole(prisma: PrismaService, id: string, user: AuthUser, roles: MemberRole[]) {
  const ev = await prisma.event.findUnique({ where: { id }, include: { ticketTypes: { orderBy: { sortOrder: 'asc' } }, org: { select: { name: true } } } });
  if (!ev) throw new NotFoundException('Event not found.');
  const m = await prisma.organizationMember.findFirst({ where: { orgId: ev.orgId, userId: user.id, status: 'ACTIVE' }, select: { role: true } });
  if (!m) throw new NotFoundException('Organization not found.');
  if (!roles.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
  return ev;
}

/** "Name, email" style lines: trimmed, without blanks, numbered from 1. */
export function lines(text: string) {
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((l) => l.text);
}

export const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
