/**
 * Exchange rates, for showing approximate prices in a visitor's currency ("₦25,000 ≈ $16").
 * Display only: fans are always charged in the event's own currency.
 *
 * Rates come from ExchangeRate-API's open endpoint (daily, no key; attribution required), refreshed every 6 hours,
 * with built-in fallback rates if it can't be reached.
 */
import { Controller, Get, Global, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';

const FALLBACK: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.52, NGN: 1550, GHS: 15.2, KES: 129, ZAR: 18.4 };

@Injectable()
export class FxService implements OnModuleInit {
  private readonly log = new Logger('FX');
  private rates: Record<string, number> = FALLBACK;
  private updatedAt: string | null = null;
  private source: 'live' | 'fallback' = 'fallback';
  private fetchedAt = 0;

  /** Tests (and offline development) use the built-in rates and never call out. */
  private readonly offline = process.env.NODE_ENV === 'test' || !!process.env.FX_OFFLINE;

  onModuleInit() {
    if (!this.offline) void this.refresh();
  }

  private async refresh() {
    if (this.offline) return;
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
      const j = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
      if (j.result !== 'success' || !j.rates?.NGN) throw new Error('bad response');
      this.rates = j.rates;
      this.updatedAt = j.time_last_update_utc ?? new Date().toUTCString();
      this.source = 'live';
      this.fetchedAt = Date.now();
    } catch (e) {
      this.log.warn(`Exchange rates unavailable, using fallback rates: ${(e as Error).message}`);
      this.fetchedAt = Date.now() - 5 * 3600_000; // try again in about an hour
    }
  }

  current() {
    if (Date.now() - this.fetchedAt > 6 * 3600_000) void this.refresh();
    return { base: 'USD', rates: this.rates, updatedAt: this.updatedAt, source: this.source, attribution: 'Rates by Exchange Rate API (exchangerate-api.com)' };
  }

  /** Converts minor units between currencies (approximate). */
  convert(cents: number, from: string, to: string) {
    if (from === to) return cents;
    const a = this.rates[from];
    const b = this.rates[to];
    if (!a || !b) return cents;
    return Math.round((cents / a) * b);
  }
}

@ApiTags('fx')
@Controller('fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  @Public()
  @Get('rates')
  rates() {
    return this.fx.current();
  }
}

@Global()
@Module({ controllers: [FxController], providers: [FxService], exports: [FxService] })
export class FxModule {}
