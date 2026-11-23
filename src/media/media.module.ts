/**
 * Event photos and videos, hosted on mediaEX.
 *
 * The mediaEX API key stays on this server. Browsers ask Eventro for an upload slot; Eventro asks mediaEX with the key
 * and hands back where to send the file:
 *   - a presigned bucket URL when mediaEX stores files in S3/R2 (the browser uploads straight there), or
 *   - PUT /media/uploads/:id on this API when mediaEX stores files on disk (this API streams the file through,
 *     adding the key, so the key never reaches the browser).
 * Each upload is recorded against the user, and events can only use media their organization's members uploaded.
 *
 * Images are served by mediaEX's on-the-fly transformer (resized, WebP/AVIF), videos by its HLS player.
 */
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
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { CurrentUser, Public, type AuthUser } from '../common/auth';

export const MEDIA_LIMITS = {
  images: 12,
  videos: 3,
  imageBytes: 25 * 1024 * 1024,
  videoBytes: 2 * 1024 * 1024 * 1024,
};

const ASSET_ID = /^ast_[a-z0-9]{6,20}$/;

export type MediaItem = { id: string; kind: 'image' | 'video'; alt?: string };

/** Public URLs for one media item (mediaEX serves public assets without a token). */
export function mediaUrls(m: MediaItem) {
  const base = `${config.mediaexUrl}/api/media/${m.id}/transform`;
  return m.kind === 'image'
    ? { ...m, url: `${base}?w=1600&fit=inside&f=auto&q=80`, thumbUrl: `${base}?w=480&h=320&fit=cover&pos=attention&f=auto&q=72` }
    : { ...m, posterUrl: `${base}?t=1&w=1280&h=720&fit=cover&f=auto&q=75`, thumbUrl: `${base}?t=1&w=480&h=320&fit=cover&f=auto&q=72`, embedUrl: `${config.mediaexUrl}/embed/${m.id}` };
}

/** The cover image URL for an event card (first image, wide crop). */
export const coverUrl = (id: string) => `${config.mediaexUrl}/api/media/${id}/transform?w=1200&h=675&fit=cover&pos=attention&f=auto&q=78`;

export class StartUploadDto {
  @ApiProperty() @IsString() @MaxLength(255) fileName: string;
  @ApiProperty() @IsInt() @Min(1) @Max(MEDIA_LIMITS.videoBytes) size: number;
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
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `mediaEX error ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        this.log.error(`mediaEX rejected the API key: ${msg}`);
        throw new ServiceUnavailableException('The media service rejected Eventro’s key. An admin needs to check MEDIAEX_API_KEY.');
      }
      throw new BadRequestException(msg);
    }
    return data as T;
  }

  async startUpload(user: AuthUser, dto: StartUploadDto) {
    const kind = dto.mimeType.startsWith('video/') ? 'video' : 'image';
    if (kind === 'image' && dto.size > MEDIA_LIMITS.imageBytes) throw new BadRequestException('Photos can be up to 25 MB.');
    const r = await this.mediaex<{ asset: { id: string }; upload: { kind: string; url?: string; method?: string; headers?: Record<string, string> } }>('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: dto.fileName, size: dto.size, mimeType: dto.mimeType }),
    });
    if (r.upload.kind !== 'single' || !r.upload.url) throw new BadRequestException('That file is too large to upload in one go.');
    await this.prisma.mediaUpload.create({ data: { id: r.asset.id, userId: user.id, kind, fileName: dto.fileName.slice(0, 255), size: dto.size } });
    // Files stored on mediaEX's own disk go through this API (which adds the key); bucket URLs are already signed.
    const viaMediaex = r.upload.url.startsWith(`${config.mediaexUrl}/api/v1/uploads/`);
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
    type Asset = { status: string; progress: number; error: string | null; width: number | null; height: number | null; duration: number };
    const r = await this.mediaex<{ asset: Asset } | Asset>(`/assets/${id}`);
    const a = 'asset' in r ? r.asset : r;
    return { ...mediaUrls({ id, kind: u.kind as MediaItem['kind'] }), status: a.status, progress: a.progress, error: a.error, width: a.width, height: a.height, duration: a.duration };
  }

  /** Sets an event's photos and videos (in order). Only media uploaded by the organization's members can be used. */
  async setEventMedia(eventId: string, user: AuthUser, items: MediaItem[]) {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, media: true } });
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

    const clean = items.map((i) => ({ id: i.id, kind: i.kind, ...(i.alt?.trim() ? { alt: i.alt.trim() } : {}) }));
    const cover = clean.find((i) => i.kind === 'image');
    await this.prisma.event.update({
      where: { id: eventId },
      data: { media: clean as unknown as Prisma.InputJsonValue, ...(cover ? { imageUrl: coverUrl(cover.id) } : {}) },
    });
    return { media: clean.map(mediaUrls), imageUrl: cover ? coverUrl(cover.id) : null };
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
