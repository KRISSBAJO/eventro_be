/**
 * Event photos and videos, hosted on mediaEX.
 *
 * The mediaEX API key stays on this server. Browsers ask Omoshow for an upload slot; Omoshow asks mediaEX with the key
 * and hands back where to send the file:
 *   - a presigned bucket URL when mediaEX stores files in S3/R2 (the browser uploads straight there), or
 *   - PUT /media/uploads/:id on this API when mediaEX stores files on disk (this API streams the file through,
 *     adding the key, so the key never reaches the browser).
 * Each upload is recorded against the user, and events can only use media their organization's members uploaded.
 *
 * Images are served by mediaEX's on-the-fly transformer (resized, WebP/AVIF), videos by its HLS player.
 */
import { holdLiveEdit, pendingEditJson, readPendingEdit } from '../domain/pending-edit';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { CurrentUser, Public, type AuthUser } from '../common/auth';

/**
 * Per event. In line with ticketing sites: enough for a cover, a gallery and a trailer or two, while keeping
 * pages fast and storage sensible.
 */
export const MEDIA_LIMITS = {
  images: 10,
  videos: 2,
  imageBytes: 15 * 1024 * 1024,
  videoBytes: 500 * 1024 * 1024,
  /** longest video, in seconds (checked once mediaEX has read the file) */
  videoSeconds: 180,
  imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  videoTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
};

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const minutes = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

const ASSET_ID = /^ast_[a-z0-9]{6,20}$/;

/** `playbackUrl` (HLS) is saved for videos that were ready when the event's media was set; it plays a video cover. */
export type MediaItem = { id: string; kind: 'image' | 'video'; alt?: string; playbackUrl?: string };

/** Public URLs for one media item (mediaEX serves public assets without a token). */
export function mediaUrls(m: MediaItem) {
  const base = `${config.mediaexUrl}/api/media/${m.id}/transform`;
  return m.kind === 'image'
    ? { ...m, url: `${base}?w=1600&fit=inside&f=auto&q=80`, thumbUrl: `${base}?w=480&h=320&fit=cover&pos=attention&f=auto&q=72` }
    : { ...m, posterUrl: `${base}?t=1&w=1280&h=720&fit=cover&f=auto&q=75`, thumbUrl: `${base}?t=1&w=480&h=320&fit=cover&f=auto&q=72`, embedUrl: `${config.mediaexUrl}/embed/${m.id}` };
}

/** The cover image for event cards: a wide crop of the first photo, or a frame from the first video. */
export const coverUrl = (id: string, kind: MediaItem['kind'] = 'image') =>
  `${config.mediaexUrl}/api/media/${id}/transform?${kind === 'video' ? 't=1&' : ''}w=1200&h=675&fit=cover&pos=attention&f=auto&q=78`;

export class StartUploadDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() multipart?: boolean;
  @ApiProperty() @IsString() @MaxLength(255) fileName: string;
  // The real per-type limits are checked in startUpload, with a readable message; this only stops absurd values.
  @ApiProperty() @IsInt() @Min(1) @Max(10 * 1024 * 1024 * 1024) size: number;
  @ApiProperty() @IsString() @Matches(/^(image|video)\/[\w.+-]+$/, { message: 'Only image and video files can be uploaded.' }) mimeType: string;
}

class MediaItemDto {
  @ApiProperty() @IsString() @Matches(ASSET_ID) id: string;
  @ApiProperty({ enum: ['image', 'video'] }) @IsIn(['image', 'video']) kind: 'image' | 'video';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(140) alt?: string;
}

export class EventMediaDto {
  @ApiProperty({ type: [MediaItemDto], description: 'In display order. The first image is the cover.' })
  @IsArray()
  @ArrayMaxSize(MEDIA_LIMITS.images + MEDIA_LIMITS.videos)
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  items: MediaItemDto[];
}

@Injectable()
export class MediaService {
  private readonly log = new Logger('Media');

  constructor(private readonly prisma: PrismaService) {}

  get enabled() {
    return !!config.mediaexApiKey;
  }

  /** Calls the mediaEX API with the key. Turns its errors into readable ones. */
  private async mediaex<T>(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<T> {
    if (!this.enabled) throw new ServiceUnavailableException('Photo and video uploads aren’t switched on yet (MEDIAEX_API_KEY is not set).');
    let res: Response;
    try {
      res = await fetch(`${config.mediaexUrl}/api/v1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.mediaexApiKey}`, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (e) {
      this.log.warn(`mediaEX unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException('The media service isn’t reachable right now. Try again in a minute.');
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not mediaEX's JSON: usually MEDIAEX_URL points at the wrong host, or a proxy in front of it is failing.
      this.log.error(`mediaEX answered ${res.status} with non-JSON for ${init.method ?? 'GET'} ${path}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      throw new ServiceUnavailableException(
        res.status === 404
          ? 'Uploads aren’t working right now: the media service isn’t answering (Omoshow’s MEDIAEX_URL may be wrong). Try again later.'
          : 'Uploads aren’t working right now: the media service sent an unexpected reply. Try again in a minute.',
      );
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `mediaEX error ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        this.log.error(`mediaEX rejected the API key: ${msg}`);
        throw new ServiceUnavailableException('The media service rejected Omoshow’s key. An admin needs to check MEDIAEX_API_KEY.');
      }
      throw new BadRequestException(msg);
    }
    return data as T;
  }

  async startUpload(user: AuthUser, dto: StartUploadDto) {
    const kind = dto.mimeType.startsWith('video/') ? 'video' : 'image';
    const mime = dto.mimeType.toLowerCase();
    if (kind === 'image' && !MEDIA_LIMITS.imageTypes.includes(mime)) throw new BadRequestException('Photos can be JPG, PNG, WebP or HEIC.');
    if (kind === 'video' && !MEDIA_LIMITS.videoTypes.includes(mime)) throw new BadRequestException('Videos can be MP4, MOV or WebM.');
    if (kind === 'image' && dto.size > MEDIA_LIMITS.imageBytes) throw new BadRequestException(`Photos can be up to ${MB(MEDIA_LIMITS.imageBytes)}.`);
    if (kind === 'video' && dto.size > MEDIA_LIMITS.videoBytes) throw new BadRequestException(`Videos can be up to ${MB(MEDIA_LIMITS.videoBytes)}.`);
    const r = await this.mediaex<{ asset: { id: string }; upload: { kind: string; url?: string; method?: string; headers?: Record<string, string>; partSize?: number; partCount?: number } }>('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: dto.fileName, size: dto.size, mimeType: dto.mimeType, multipart: dto.multipart === true }),
    });
    const multipart = r.upload.kind === 'multipart' && dto.multipart === true;
    if (!multipart && (r.upload.kind !== 'single' || !r.upload.url)) throw new BadRequestException('That file requires a resumable upload.');
    await this.prisma.mediaUpload.create({ data: { id: r.asset.id, userId: user.id, kind, fileName: dto.fileName.slice(0, 255), size: dto.size } });
    // Files stored on mediaEX's own disk go through this API (which adds the key); bucket URLs are already signed.
    if (multipart) return { id: r.asset.id, kind, upload: { through: 'multipart' as const, partSize: r.upload.partSize, partCount: r.upload.partCount } };
    const viaMediaex = r.upload.url!.startsWith(`${config.mediaexUrl}/api/v1/uploads/`);
    return {
      id: r.asset.id,
      kind,
      upload: viaMediaex
        ? { url: null, method: 'PUT', headers: {}, through: 'eventro' as const }
        : { url: r.upload.url, method: r.upload.method ?? 'PUT', headers: r.upload.headers ?? {}, through: 'bucket' as const },
    };
  }

  private async own(id: string, user: AuthUser) {
    if (!ASSET_ID.test(id)) throw new NotFoundException('Upload not found.');
    const u = await this.prisma.mediaUpload.findUnique({ where: { id } });
    if (!u || u.userId !== user.id) throw new NotFoundException('Upload not found.');
    return u;
  }

  /** Streams the browser's file to mediaEX, adding the key. */
  async listParts(id: string, user: AuthUser) {
    await this.own(id, user);
    return this.mediaex(`/uploads/${id}/parts`);
  }

  async partTarget(id: string, user: AuthUser, number: number) {
    await this.own(id, user);
    if (!Number.isSafeInteger(number) || number < 1 || number > 10000) throw new BadRequestException('Invalid upload part.');
    type Part = { number: number; size: number; url: string; headers: Record<string, string> };
    const result = await this.mediaex<{ parts: Part[] }>(`/uploads/${id}/parts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ numbers: [number] }),
    });
    const part = result.parts[0];
    if (!part || part.number !== number || !Number.isSafeInteger(part.size) || part.size < 1) throw new ServiceUnavailableException('Unexpected upload part.');
    const relay = part.url === `${config.mediaexUrl}/api/v1/uploads/${id}/parts/${number}`;
    return { number, size: part.size, through: relay ? 'eventro' : 'bucket', url: relay ? null : part.url, headers: relay ? {} : part.headers };
  }

  async relayPart(id: string, user: AuthUser, number: number, req: Request) {
    const part = await this.partTarget(id, user, number);
    if (part.through !== 'eventro' || Number(req.headers['content-length']) !== part.size) throw new BadRequestException('Unexpected upload destination or part size.');
    return this.mediaex(`/uploads/${id}/parts/${number}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(part.size) },
      body: Readable.toWeb(req) as never, duplex: 'half',
    });
  }

  async relay(id: string, user: AuthUser, req: Request) {
    const u = await this.own(id, user);
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length !== u.size) throw new BadRequestException('The file size doesn’t match the upload.');
    await this.mediaex(`/uploads/${id}`, {
      method: 'PUT',
      headers: { 'content-type': String(req.headers['content-type'] ?? 'application/octet-stream'), 'content-length': String(length) },
      body: Readable.toWeb(req) as never,
      duplex: 'half',
    });
    return { received: true };
  }

  async complete(id: string, user: AuthUser) {
    await this.own(id, user);
    await this.mediaex(`/uploads/${id}/complete`, { method: 'POST' });
    return this.status(id, user);
  }

  /** Processing progress, so the uploader can show "Processing 40%" until a video is ready to play. */
  async status(id: string, user: AuthUser) {
    const u = await this.own(id, user);
    type Asset = { status: string; progress: number; error: string | null; width: number | null; height: number | null; duration: number; playbackUrl?: string | null };
    const r = await this.mediaex<{ asset: Asset } | Asset>(`/assets/${id}`);
    const a = 'asset' in r ? r.asset : r;
    const tooLong = u.kind === 'video' && a.duration > MEDIA_LIMITS.videoSeconds;
    const playbackUrl = u.kind === 'video' && a.status === 'ready' && a.playbackUrl && !tooLong ? a.playbackUrl : undefined;
    return {
      ...mediaUrls({ id, kind: u.kind as MediaItem['kind'], playbackUrl }),
      status: tooLong ? 'failed' : a.status,
      progress: a.progress,
      error: tooLong ? `Videos can be up to ${minutes(MEDIA_LIMITS.videoSeconds)} long; this one is ${minutes(a.duration)}.` : a.error,
      width: a.width,
      height: a.height,
      duration: a.duration,
    };
  }

  /** Sets an event's photos and videos (in order). Only media uploaded by the organization's members can be used. */
  async setEventMedia(eventId: string, user: AuthUser, items: MediaItem[]) {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, media: true, status: true, title: true, subtitle: true, imageUrl: true, pendingEdit: true } });
    if (!ev) throw new NotFoundException('Event not found.');
    const member = await this.prisma.organizationMember.findFirst({ where: { orgId: ev.orgId, userId: user.id, status: 'ACTIVE', role: { in: ['ADMIN', 'MANAGER'] } } });
    if (!member) throw new ForbiddenException('Your role can’t change this event’s media.');

    const ids = [...new Set(items.map((i) => i.id))];
    if (ids.length !== items.length) throw new BadRequestException('Each photo or video can only be added once.');
    if (items.filter((i) => i.kind === 'image').length > MEDIA_LIMITS.images) throw new BadRequestException(`Up to ${MEDIA_LIMITS.images} photos per event.`);
    if (items.filter((i) => i.kind === 'video').length > MEDIA_LIMITS.videos) throw new BadRequestException(`Up to ${MEDIA_LIMITS.videos} videos per event.`);

    const current = new Set(((ev.media as MediaItem[] | null) ?? []).map((m) => m.id));
    const members = await this.prisma.organizationMember.findMany({ where: { orgId: ev.orgId, userId: { not: null } }, select: { userId: true } });
    const uploads = await this.prisma.mediaUpload.findMany({ where: { id: { in: ids } } });
    const byId = new Map(uploads.map((u) => [u.id, u]));
    const team = new Set(members.map((m) => m.userId));
    for (const i of items) {
      if (current.has(i.id)) continue;
      const u = byId.get(i.id);
      if (!u || !team.has(u.userId)) throw new BadRequestException('One of those files wasn’t uploaded by your team.');
      if (u.kind !== i.kind) throw new BadRequestException(`${u.fileName} isn’t a ${i.kind}.`);
    }

    const clean: MediaItem[] = items.map((i) => ({ id: i.id, kind: i.kind, ...(i.alt?.trim() ? { alt: i.alt.trim() } : {}) }));
    // Videos that have finished processing keep their stream address, so a video cover can play on the event page.
    const before = new Map(((ev.media as MediaItem[] | null) ?? []).map((m) => [m.id, m]));
    await Promise.all(
      clean
        .filter((i) => i.kind === 'video')
        .map(async (i) => {
          const known = before.get(i.id)?.playbackUrl;
          i.playbackUrl = known ?? (await this.playbackUrl(i.id));
          if (!i.playbackUrl) delete i.playbackUrl;
        }),
    );
    // The first item is the cover, photo or video (a video's card image is a frame from it).
    const cover = clean[0];
    const imageUrl = cover ? coverUrl(cover.id, cover.kind) : null;
    const change = { media: clean, ...(imageUrl ? { imageUrl } : {}) };
    // A live event's new photos and videos wait for Omoshow to check them (see domain/pending-edit); fans keep the
    // approved ones. Removing or reordering ones already approved happens at once.
    if (ev.status === 'PUBLISHED' && clean.some((i) => !current.has(i.id))) {
      const { next } = holdLiveEdit(ev, change, user.id);
      await this.prisma.event.update({ where: { id: eventId }, data: { pendingEdit: pendingEditJson(next) ?? Prisma.DbNull, pendingEditNote: null } });

      return { media: clean.map(mediaUrls), imageUrl, heldForReview: ['media'] };
    }
    const waiting = readPendingEdit(ev.pendingEdit);
    const next = waiting ? holdLiveEdit({ ...ev, ...change }, change, user.id).next : undefined;
    await this.prisma.event.update({
      where: { id: eventId },
      data: { media: clean as unknown as Prisma.InputJsonValue, ...(imageUrl ? { imageUrl } : {}), ...(waiting ? { pendingEdit: pendingEditJson(next ?? null) ?? Prisma.DbNull } : {}) },
    });
    return { media: clean.map(mediaUrls), imageUrl, heldForReview: [] as string[] };
  }

  /** A ready video's HLS address, or undefined while it's still processing (or mediaEX can't say). Too-long videos are refused. */
  private async playbackUrl(id: string) {
    type A = { status: string; playbackUrl?: string | null; duration?: number };
    let a: A;
    try {
      const r = await this.mediaex<{ asset: A } | A>(`/assets/${id}`);
      a = 'asset' in r ? r.asset : r;
    } catch {
      return undefined;
    }
    if ((a.duration ?? 0) > MEDIA_LIMITS.videoSeconds) {
      throw new BadRequestException(`Videos can be up to ${minutes(MEDIA_LIMITS.videoSeconds)} long; one of yours is ${minutes(a.duration ?? 0)}.`);
    }
    return a.status === 'ready' && a.playbackUrl ? a.playbackUrl : undefined;
  }
}

@ApiTags('media')
@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Whether uploads are on, and the limits, so the website can show the right uploader. */
  @Public()
  @Get('media/config')
  cfg() {
    return { enabled: this.media.enabled, ...MEDIA_LIMITS };
  }

  @ApiBearerAuth()
  @Post('media/uploads')
  start(@CurrentUser() u: AuthUser, @Body() dto: StartUploadDto) {
    return this.media.startUpload(u, dto);
  }

  @ApiBearerAuth()
  @Put('media/uploads/:id')
  @HttpCode(200)
  relay(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.media.relay(id, u, req);
  }

  @ApiBearerAuth()
  @Get('media/uploads/:id/parts')
  parts(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.media.listParts(id, u);
  }

  @ApiBearerAuth()
  @Post('media/uploads/:id/parts/:number')
  part(@Param('id') id: string, @Param('number') number: string, @CurrentUser() u: AuthUser) {
    return this.media.partTarget(id, u, Number(number));
  }

  @ApiBearerAuth()
  @Put('media/uploads/:id/parts/:number')
  putPart(@Param('id') id: string, @Param('number') number: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.media.relayPart(id, u, Number(number), req);
  }

  @ApiBearerAuth()
  @Post('media/uploads/:id/complete')
  @HttpCode(200)
  complete(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.media.complete(id, u);
  }

  @ApiBearerAuth()
  @Get('media/uploads/:id')
  status(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.media.status(id, u);
  }

  @ApiBearerAuth()
  @Put('organizer/events/:id/media')
  setEventMedia(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: EventMediaDto) {
    return this.media.setEventMedia(id, u, dto.items);
  }
}

@Module({ controllers: [MediaController], providers: [MediaService] })
export class MediaModule {}

