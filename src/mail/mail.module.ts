/**
 * Email through Resend (https://resend.com). Every attempt is written to EmailLog (SENT, FAILED or SKIPPED).
 * Without RESEND_API_KEY nothing leaves the server: messages are logged as SKIPPED, which is how tests and
 * local development run.
 *
 * `send` is for one message; `sendMany` goes through Resend's batch endpoint 100 at a time and is what alerts
 * and broadcasts use. Neither throws: a failed email never breaks the request that triggered it.
 */
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { config } from '../config';

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** e.g. a one-click unsubscribe URL; becomes the List-Unsubscribe header */
  unsubscribeUrl?: string;
};

const BATCH = 100;

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');

  constructor(private readonly prisma: PrismaService) {}

  get enabled() {
    return !!config.resendApiKey;
  }

  async send(kind: string, mail: Mail) {
    return (await this.sendMany(kind, [mail]))[0] ?? false;
  }

  /** Sends each message on its own (no shared To: line). Returns whether each one was accepted. */
  async sendMany(kind: string, mails: Mail[]): Promise<boolean[]> {
    const results: boolean[] = [];
    for (let i = 0; i < mails.length; i += BATCH) {
      const chunk = mails.slice(i, i + BATCH);
      results.push(...(await this.sendChunk(kind, chunk)));
    }
    return results;
  }

  private async sendChunk(kind: string, chunk: Mail[]): Promise<boolean[]> {
    const record = (m: Mail, status: 'SENT' | 'FAILED' | 'SKIPPED', providerId?: string | null, error?: string) =>
      this.prisma.emailLog.create({ data: { to: m.to, subject: m.subject.slice(0, 300), kind, status, providerId: providerId ?? null, error: error?.slice(0, 500) } });

    if (!this.enabled) {
      await Promise.all(chunk.map((m) => record(m, 'SKIPPED', null, 'RESEND_API_KEY is not set')));
      return chunk.map(() => false);
    }

    const body = chunk.map((m) => ({
      from: config.mailFrom,
      to: [m.to],
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(m.unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${m.unsubscribeUrl}>` } } : {}),
    }));
    try {
      const res = await fetch(`${config.resendUrl}${chunk.length === 1 ? '/emails' : '/emails/batch'}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(chunk.length === 1 ? body[0] : config.resendUrl === 'https://api.relykit.com' ? { emails: body } : body),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; data?: { id: string }[]; message?: string; name?: string };
      if (!res.ok) throw new Error(json.message || json.name || `Resend answered ${res.status}`);
      const ids = chunk.length === 1 ? [json.id] : (json.data ?? []).map((d) => d.id);
      await Promise.all(chunk.map((m, i) => record(m, 'SENT', ids[i] ?? null)));
      return chunk.map(() => true);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`Could not send ${chunk.length} "${kind}" email(s): ${msg}`);
      await Promise.all(chunk.map((m) => record(m, 'FAILED', null, msg)));
      return chunk.map(() => false);
    }
  }
}

/* ---------- templates ---------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type Template = {
  /** inbox preview line */
  preheader: string;
  heading: string;
  /** paragraphs of plain text (escaped here) */
  paragraphs: string[];
  /** optional big number row, e.g. a price drop */
  highlight?: { label: string; value: string; was?: string };
  cta?: { label: string; url: string };
  /** small print, e.g. why you got this and how to stop */
  footer: string;
  footerLink?: { label: string; url: string };
};

/** One plain, mobile-friendly layout for every Omoshow email (tables and inline styles for mail clients). */
export function render(t: Template): { html: string; text: string } {
  const p = t.paragraphs.map((x) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#3f3f46">${esc(x)}</p>`).join('');
  const hl = t.highlight
    ? `<table role="presentation" width="100%" style="margin:6px 0 20px;border-collapse:collapse"><tr><td style="padding:16px 18px;border-radius:14px;background:#fff4f2;border:1px solid #ffd6d0">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#a1a1aa">${esc(t.highlight.label)}</div>
        <div style="margin-top:4px;font-size:28px;font-weight:800;color:#d7321f">${esc(t.highlight.value)}${
          t.highlight.was ? ` <span style="font-size:16px;font-weight:600;color:#a1a1aa;text-decoration:line-through">${esc(t.highlight.was)}</span>` : ''
        }</div></td></tr></table>`
    : '';
  const cta = t.cta
    ? `<a href="${esc(t.cta.url)}" style="display:inline-block;margin:6px 0 4px;padding:13px 22px;border-radius:999px;background:#ff4d3d;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none">${esc(t.cta.label)}</a>`
    : '';
  const foot = `${esc(t.footer)}${t.footerLink ? ` <a href="${esc(t.footerLink.url)}" style="color:#71717a">${esc(t.footerLink.label)}</a>` : ''}`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>${esc(t.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(t.preheader)}</span>
<table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f4f5"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" style="max-width:560px;border-collapse:collapse">
<tr><td style="padding:0 6px 16px;font-size:20px;font-weight:800;letter-spacing:-.03em;color:#0a0a0b"><span style="color:#ff4d3d">■</span>omoshow</td></tr>
<tr><td style="padding:28px 26px;border-radius:20px;background:#ffffff">
<h1 style="margin:0 0 14px;font-size:24px;line-height:1.2;letter-spacing:-.02em;color:#0a0a0b">${esc(t.heading)}</h1>
${hl}${p}${cta}
</td></tr>
<tr><td style="padding:16px 8px;font-size:12px;line-height:1.5;color:#71717a">${foot}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    t.heading,
    '',
    ...(t.highlight ? [`${t.highlight.label}: ${t.highlight.value}${t.highlight.was ? ` (was ${t.highlight.was})` : ''}`, ''] : []),
    ...t.paragraphs.flatMap((x) => [x, '']),
    ...(t.cta ? [`${t.cta.label}: ${t.cta.url}`, ''] : []),
    `${t.footer}${t.footerLink ? ` ${t.footerLink.label}: ${t.footerLink.url}` : ''}`,
  ].join('\n');
  return { html, text };
}

/** "$25.88", "₦40,000": an amount in minor units, for emails. */
export function formatMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
