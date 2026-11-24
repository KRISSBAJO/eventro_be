import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';

export type Role = 'FAN' | 'ORGANIZER' | 'ADMIN';
export type AuthUser = { id: string; email: string; name: string; roles: Role[] };

class SuspendedError extends Error {}

const PUBLIC = 'eventro:public';
const OPTIONAL = 'eventro:optional-auth';
const ROLES = 'eventro:roles';

/** Route needs no sign-in. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route works signed out, but uses the user when a token is sent. */
export const OptionalAuth = () => SetMetadata(OPTIONAL, true);
/** Route needs one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return (ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>().user ?? null) as AuthUser | null;
});

/**
 * Global guard: every route needs a valid Bearer token unless marked @Public or @OptionalAuth.
 * The user is re-read from the database so role changes apply immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL, targets);
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; iat?: number }>(token);
        const u = await this.prisma.user.findUnique({ where: { id: payload.sub } });
        if (u?.suspendedAt) throw new SuspendedError();
        // Signed in before the password last changed (a reset or change elsewhere): that session has ended.
        // `iat` is in whole seconds; sessions issued by the change itself are stamped after it (see AuthService).
        if (u?.passwordChangedAt && (payload.iat ?? 0) * 1000 <= u.passwordChangedAt.getTime()) throw new Error('session ended by a password change');
        if (u) req.user = { id: u.id, email: u.email, name: u.name, roles: u.roles as Role[] };
      } catch (e) {
        // A suspended account is refused everywhere, even on public routes, so it can't keep buying.
        if (e instanceof SuspendedError) throw new ForbiddenException('This account is suspended. Contact Eventro support.');
        if (!isPublic && !optional) throw new UnauthorizedException('Your session has expired. Please sign in again.');
      }
    }

    if (isPublic || optional) return true;
    if (!req.user) throw new UnauthorizedException('Sign in to continue.');
    if (roles?.length && !roles.some((r) => req.user!.roles.includes(r))) {
      throw new ForbiddenException('You don’t have access to this.');
    }
    return true;
  }
}
