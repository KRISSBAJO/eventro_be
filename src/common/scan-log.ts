import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ScanMethod, ScanResult } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * The door scan log (ScanAttempt): every scan, admitted or not, from online scans, typed-in codes and offline scans
 * when they sync. It backs the resale scan guarantee ("it didn't scan" can be checked against what the door saw).
 *
 * Only what the scan needs is kept: event, ticket (when the code named a real ticket), result, how it was scanned,
 * the scanner, the staff member and the time. Never the code itself, names or IPs. Writing it never breaks a scan.
 */
export type ScanEntry = {
  eventId: string;
  ticketId: string | null;
  result: ScanResult;
  method: ScanMethod;
  deviceId: string | null;
  userId: string;
  at: Date;
};

@Injectable()
export class ScanLog {
  private readonly log = new Logger('ScanLog');

  constructor(private readonly prisma: PrismaService) {}

  /** One online scan. */
  async record(e: ScanEntry) {
    try {
      await this.prisma.scanAttempt.create({ data: e });
    } catch (err) {
      this.log.warn(`Scan log for event ${e.eventId}: ${(err as Error).message}`);
    }
  }

  /**
   * Offline scans being synced, with the times the scanner made them. Sending the same batch again logs nothing
   * new: each scan's key is a hash of the scanner and `scanned` (the ticket code read and the scanner's own timestamp).
   */
  async recordSynced(entries: (ScanEntry & { scanned: string })[]) {
    if (!entries.length) return;
    try {
      await this.prisma.scanAttempt.createMany({
        data: entries.map(({ scanned, ...e }) => ({
          ...e,
          dedupeKey: createHash('sha256').update(`${e.deviceId ?? ''}|${scanned}`).digest('base64url').slice(0, 32),
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.log.warn(`Scan log sync for event ${entries[0].eventId}: ${(err as Error).message}`);
    }
  }
}
