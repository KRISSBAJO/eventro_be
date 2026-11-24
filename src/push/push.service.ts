/**
 * Push notifications to the mobile app through Expo's push service (https://docs.expo.dev/push-notifications/).
 *
 * Phones register their Expo push token (`POST /me/push-devices`); fans choose what they get
 * (`GET/PATCH /me/notify-prefs`). `PushService.send` writes one NotificationLog row per person and message
 * (SENT, FAILED or SKIPPED: no phones, or that kind switched off) and sends to all of that person's phones,
 * 100 messages per request. A `dedupeKey` (unique in NotificationLog) means a message is never sent twice, which
 * is what keeps reminders to one per person per event.
 *
 * Expo answers with a "ticket" per message; `DeviceNotRegistered` (the app was uninstalled) disables that phone.
 * Tickets that were accepted are checked again later through Expo's receipts endpoint, which can also report
 * `DeviceNotRegistered`.
 *
 * Nothing here throws into the request that triggered it: callers use `notify` (fire and forget) and errors are
 * logged. Without network access (local development) sends are just logged as FAILED.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Param,
  Patch,
  Post,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { CurrentUser, type AuthUser } from '../common/auth';

/* ---------- preferences ---------- */

export const NOTIFY_PREFS = ['orders', 'tickets', 'priceDrops', 'reminders', 'marketing'] as const;
export type NotifyPref = (typeof NOTIFY_PREFS)[number];
export type NotifyPrefs = Record<NotifyPref, boolean>;
/** Everything on except marketing. */
export const DEFAULT_PREFS: NotifyPrefs = { orders: true, tickets: true, priceDrops: true, reminders: true, marketing: false };

export function prefsOf(raw: unknown): NotifyPrefs {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of NOTIFY_PREFS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

/** `ExponentPushToken[…]` or `ExpoPushToken[…]`. */
export const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]{8,200}\]$/;

export class PushDeviceDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @IsString()
  @MaxLength(250)
  @Matches(EXPO_TOKEN, { message: 'token must be an Expo push token (ExponentPushToken[…]).' })
  token: string;
  @ApiPropertyOptional({ example: 'ios' }) @IsOptional() @IsString() @MaxLength(20) platform?: string;
  @ApiPropertyOptional({ example: 'Ada’s iPhone' }) @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}

export class NotifyPrefsDto {
  @ApiPropertyOptional({ description: 'Order confirmations, refunds, resale sales, cancellations' }) @IsOptional() @IsBoolean() orders?: boolean;
  @ApiPropertyOptional({ description: 'Transfers and gifts' }) @IsOptional() @IsBoolean() tickets?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() priceDrops?: boolean;
  @ApiPropertyOptional({ description: 'The day before and when doors open' }) @IsOptional() @IsBoolean() reminders?: boolean;
  @ApiPropertyOptional({ description: 'Off unless turned on' }) @IsOptional() @IsBoolean() marketing?: boolean;
}

/* ---------- sending ---------- */

export type PushMessage = {
  userId: string;
  title: string;
  body: string;
  /** Sent to the app with the notification; `url` (eventro://…) and `path` are for deep links. */
  data?: Record<string, unknown>;
  /** Never sends two messages with the same key (e.g. `reminder.day:<eventId>:<userId>`). */
  dedupeKey?: string;
};

type ExpoTicket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };
type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

const CHUNK = 100;
const RECEIPT_CHUNK = 1000;
/** receipt ids waiting to be checked; capped so a long outage can't grow memory without bound */
const MAX_PENDING_RECEIPTS = 20_000;

export type SendSummary = { sent: number; failed: number; skipped: number; duplicate: number };

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Push');
  private timer: NodeJS.Timeout | null = null;
  /** Expo receipt id → push token, checked by `checkReceipts`. Kept in memory: a restart only skips some checks. */
  private readonly pendingReceipts = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.checkReceipts().catch((e) => this.log.warn(`Receipts: ${(e as Error).message}`)), 15 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire and forget: never throws, never holds up the caller. */
  notify(kind: string, pref: NotifyPref, messages: PushMessage[]) {
    if (!messages.length) return;
    void this.send(kind, pref, messages).catch((e) => this.log.error(`Push "${kind}": ${(e as Error).message}`));
  }

  async send(kind: string, pref: NotifyPref, messages: PushMessage[]): Promise<SendSummary> {
    const summary: SendSummary = { sent: 0, failed: 0, skipped: 0, duplicate: 0 };
    if (!messages.length) return summary;

    // 1. Claim each message's log row (and dedupe key) before sending, so a repeat never goes out.
    const keys = messages.map((m) => m.dedupeKey).filter((k): k is string => !!k);
    const taken = new Set(
      keys.length ? (await this.prisma.notificationLog.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey!) : [],
    );
    const claimed: { m: PushMessage; logId: string }[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.dedupeKey && (taken.has(m.dedupeKey) || seen.has(m.dedupeKey))) {
        summary.duplicate++;
        continue;
      }
      if (m.dedupeKey) seen.add(m.dedupeKey);
      try {
        const row = await this.prisma.notificationLog.create({
          data: { userId: m.userId, kind, title: m.title.slice(0, 200), body: m.body.slice(0, 500), data: (m.data ?? undefined) as Prisma.InputJsonValue | undefined, status: 'PENDING', dedupeKey: m.dedupeKey ?? null },
          select: { id: true },
        });
        claimed.push({ m, logId: row.id });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') summary.duplicate++;
        else throw e;
      }
    }
    if (!claimed.length) return summary;

    // 2. Who can get it: not suspended, kind switched on, at least one phone.
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(claimed.map((c) => c.m.userId))] } },
      select: { id: true, notifyPrefs: true, suspendedAt: true, pushDevices: { where: { disabledAt: null }, select: { token: true } } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const skip = async (logId: string, why: string) => {
      summary.skipped++;
      await this.prisma.notificationLog.update({ where: { id: logId }, data: { status: 'SKIPPED', error: why } });
    };
    const outgoing: { logId: string; token: string; m: PushMessage }[] = [];
    for (const c of claimed) {
      const u = byId.get(c.m.userId);
      if (!u) await skip(c.logId, 'No account');
      else if (u.suspendedAt) await skip(c.logId, 'Account suspended');
      else if (!prefsOf(u.notifyPrefs)[pref]) await skip(c.logId, `Switched off (${pref})`);
      else if (!u.pushDevices.length) await skip(c.logId, 'No push devices');
      else for (const d of u.pushDevices) outgoing.push({ logId: c.logId, token: d.token, m: c.m });
    }

    // 3. Send, 100 at a time. A person's message is SENT if any of their phones took it.
    const results = new Map<string, { ok: boolean; errors: string[] }>();
    const note = (logId: string, ok: boolean, error?: string) => {
      const r = results.get(logId) ?? { ok: false, errors: [] };
      if (ok) r.ok = true;
      if (error) r.errors.push(error);
      results.set(logId, r);
    };
    for (let i = 0; i < outgoing.length; i += CHUNK) {
      const chunk = outgoing.slice(i, i + CHUNK);
      let tickets: ExpoTicket[] = [];
      let failure: string | null = null;
      try {
        tickets = await this.post<ExpoTicket[]>(
          '/send',
          chunk.map((o) => ({ to: o.token, title: o.m.title, body: o.m.body, data: o.m.data ?? {}, sound: 'default', priority: 'high' })),
        );
      } catch (e) {
        failure = (e as Error).message;
        this.log.warn(`Could not send ${chunk.length} "${kind}" push(es): ${failure}`);
      }
      const gone: string[] = [];
      chunk.forEach((o, j) => {
        if (failure) return note(o.logId, false, failure);
        const t = tickets[j];
        if (!t) return note(o.logId, false, 'No answer from Expo for this message');
        if (t.status === 'ok') {
          if (this.pendingReceipts.size < MAX_PENDING_RECEIPTS) this.pendingReceipts.set(t.id, o.token);
          return note(o.logId, true);
        }
        const code = t.details?.error;
        if (code === 'DeviceNotRegistered') gone.push(o.token);
        note(o.logId, false, `${code ?? 'Error'}: ${t.message ?? ''}`.trim());
      });
      if (gone.length) await this.disable(gone);
    }

    // 4. Final status per person.
    for (const [logId, r] of results) {
      if (r.ok) summary.sent++;
      else summary.failed++;
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: { status: r.ok ? 'SENT' : 'FAILED', error: r.errors.length ? r.errors.join('; ').slice(0, 500) : null },
      });
    }
    return summary;
  }

  /** Asks Expo how accepted messages went; phones reported as DeviceNotRegistered are disabled. */
  async checkReceipts() {
    const ids = [...this.pendingReceipts.keys()];
    let disabled = 0;
    for (let i = 0; i < ids.length; i += RECEIPT_CHUNK) {
      const chunk = ids.slice(i, i + RECEIPT_CHUNK);
      const receipts = await this.post<Record<string, ExpoReceipt>>('/getReceipts', { ids: chunk });
      const gone: string[] = [];
      for (const id of chunk) {
        const r = receipts[id];
        if (!r) continue; // not ready yet: try again next time
        const token = this.pendingReceipts.get(id);
        this.pendingReceipts.delete(id);
        if (r.status === 'error') {
          if (r.details?.error === 'DeviceNotRegistered' && token) gone.push(token);
          else this.log.warn(`Push receipt ${id}: ${r.details?.error ?? 'error'} ${r.message ?? ''}`);
        }
      }
      if (gone.length) disabled += await this.disable(gone);
    }
    return { checked: ids.length, disabled };
  }

  private async disable(tokens: string[]) {
    const { count } = await this.prisma.pushDevice.updateMany({ where: { token: { in: tokens }, disabledAt: null }, data: { disabledAt: new Date() } });
    if (count) this.log.log(`Disabled ${count} push device(s): no longer registered`);
    return count;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${config.expoPushUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json',
        ...(config.expoAccessToken ? { authorization: `Bearer ${config.expoAccessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { code?: string; message?: string }[] };
    if (!res.ok || json.data === undefined) {
      const e = json.errors?.[0];
      throw new Error(e ? `${e.code ?? 'Error'}: ${e.message ?? ''}` : `Expo answered ${res.status}`);
    }
    return json.data;
  }

  /* ---------- devices and preferences ---------- */

  /** Registers this phone for the signed-in account (a token moves to whoever registers it last). */
  async register(user: AuthUser, dto: PushDeviceDto) {
    const now = new Date();
    const fields = { userId: user.id, platform: dto.platform?.trim().toLowerCase() || null, deviceName: dto.deviceName?.trim() || null, lastSeenAt: now, disabledAt: null };
    const d = await this.prisma.pushDevice.upsert({ where: { token: dto.token }, create: { token: dto.token, ...fields }, update: fields });
    return { id: d.id, token: d.token, platform: d.platform, deviceName: d.deviceName, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
  }

  async unregister(user: AuthUser, token: string) {
    const { count } = await this.prisma.pushDevice.updateMany({ where: { token, userId: user.id, disabledAt: null }, data: { disabledAt: new Date() } });
    return { removed: count > 0 };
  }

  async prefs(user: AuthUser) {
    const u = await this.prisma.user.findUnique({ where: { id: user.id }, select: { notifyPrefs: true } });
    return prefsOf(u?.notifyPrefs);
  }

  async setPrefs(user: AuthUser, dto: NotifyPrefsDto) {
    const next = { ...(await this.prefs(user)) };
    for (const k of NOTIFY_PREFS) if (typeof dto[k] === 'boolean') next[k] = dto[k]!;
    await this.prisma.user.update({ where: { id: user.id }, data: { notifyPrefs: next } });
    return next;
  }
}

/* ---------- routes ---------- */

@ApiTags('push')
@ApiBearerAuth()
@Controller('me')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Register this phone's Expo push token (again after every app start is fine). */
  @Post('push-devices')
  @HttpCode(200)
  register(@CurrentUser() user: AuthUser, @Body() dto: PushDeviceDto) {
    return this.push.register(user, dto);
  }

  /** Stop notifications to this phone. The token goes in the path, URL-encoded. */
  @Delete('push-devices/:token')
  unregister(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    if (!EXPO_TOKEN.test(token)) throw new BadRequestException('Not an Expo push token.');
    return this.push.unregister(user, token);
  }

  @Get('notify-prefs')
  prefs(@CurrentUser() user: AuthUser) {
    return this.push.prefs(user);
  }

  /** Change some choices; missing keys stay as they are. Answers with all of them. */
  @Patch('notify-prefs')
  setPrefs(@CurrentUser() user: AuthUser, @Body() dto: NotifyPrefsDto) {
    return this.push.setPrefs(user, dto);
  }
}
