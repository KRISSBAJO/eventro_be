import { Global, Module } from '@nestjs/common';
import { PushController, PushService } from './push.service';
import { NoticeService } from './notices';

/** Push notifications (PushService) and what triggers them (NoticeService); available everywhere. */
@Global()
@Module({ controllers: [PushController], providers: [PushService, NoticeService], exports: [PushService, NoticeService] })
export class PushModule {}
