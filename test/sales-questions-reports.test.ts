/**
 * Scheduled sales and presale codes, questions at checkout, the age limit, "report this event" and the calendar file.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { WaitlistService } from '../src/waitlist/waitlist.module';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
let waitlist: WaitlistService;
const run = Date.now().toString(36);
const DAY = 86_400_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed as Json, text };
}
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const account = async (email: string, name: string) => {
  const s = await call('POST', '/auth/signup', { email, name, password: 'test-password-123' });
  if (s.status < 300) return s.body as { token: string; user: Json };
  return (await ok(call('POST', '/auth/login', { email, password: 'test-password-123' }))) as { token: string; user: Json };
};

before(async () => {
  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  const { WaitlistService: Svc } = await import('../src/waitlist/waitlist.module');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
  waitlist = app.get(Svc);
});

after(async () => {
  await app?.close();
});

let n = 0;
/** A published event with General ($30) and VIP ($90); `extra` goes on the event, `vip` on the VIP ticket type. */
async function show(org: string, admin: string, extra: Json = {}, vip: Json = {}) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Sale Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Sale Show ${run} ${n}`,
        category: 'CONCERTS',
        venue: { name: 'Sale Hall', address: '1 Sale St', city: 'London', country: 'GB' },
        timezone: 'Europe/London',
        startsAt: new Date(Date.now() + 20 * DAY).toISOString(),
        ticketTypes: [
          { name: 'General', basePriceCents: 3000, capacity: 50 },
          { name: 'VIP', basePriceCents: 9000, capacity: 10, ...vip },
        ],
        ...extra,
      },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  const tier = (name: string) => (ev.ticketTypes as Json[]).find((t) => t.name === name)!;
  return { org: o as Json, ev, general: tier('General'), vip: tier('VIP') };
}

test('scheduled sales: a ticket type goes on sale later, a presale code opens it early, sales can end', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`sale-o1-${run}@test.local`, 'Sal Organizer');
  const fan = await account(`sale-f1-${run}@test.local`, 'Fay Fan');
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  const { ev, general, vip } = await show(org.token, admin.token, { presaleCode: 'fans-first' }, { salesStart: soon });

  // The public page says when, and that a presale is open, but never the code.
  const page = await call('GET', `/events/${ev.slug}`);
  const types = page.body.ticketTypes as Json[];
  assert.deepEqual(types.map((t) => [t.name, t.saleState]), [['General', 'ON'], ['VIP', 'SOON']]);
  assert.equal(types[1].salesStart, soon);
  assert.deepEqual(page.body.presale, { open: true, startsAt: null });
  assert.ok(!/fans-first/i.test(page.text), 'the code stays on the server');
  // The organizer sees it.
  const mine = (await ok(call('GET', `/organizer/orgs/${(await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).orgId}/events`, undefined, org.token))) as Json[];
  const row = mine.find((e) => e.id === ev.id)!;
  assert.equal(row.presaleCode, 'FANS-FIRST');
  assert.equal(row.ticketTypes.find((t: Json) => t.name === 'VIP').salesStart, soon);

  // Without the code VIP isn't on sale; General is.
  assert.equal((await call('POST', '/holds', { ticketTypeId: vip.id, quantity: 1 }, fan.token)).status, 400);
  assert.equal((await call('POST', '/holds', { ticketTypeId: vip.id, quantity: 1, accessCode: 'nope' }, fan.token)).status, 400);
  await ok(call('POST', '/holds', { ticketTypeId: general.id, quantity: 1 }, fan.token));
  assert.equal((await call('POST', `/events/${ev.slug}/presale`, { code: 'nope' })).status, 400);
  const opened = await ok(call('POST', `/events/${ev.slug}/presale`, { code: 'Fans-First' }));
  assert.deepEqual([opened.ok, opened.ticketTypeIds], [true, [vip.id]]);
  const held = await ok(call('POST', '/holds', { ticketTypeId: vip.id, quantity: 2, accessCode: 'Fans-First' }, fan.token));
  assert.equal(held.quantity, 2);
  // A cart takes the code too.
  assert.equal((await call('POST', '/holds/cart', { items: [{ ticketTypeId: general.id, quantity: 1 }, { ticketTypeId: vip.id, quantity: 1 }] }, fan.token)).status, 400);
  await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: general.id, quantity: 1 }, { ticketTypeId: vip.id, quantity: 1 }], accessCode: 'FANS-FIRST' }, fan.token));

  // A presale that hasn't opened yet doesn't take the code.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { presaleStartsAt: new Date(Date.now() + DAY).toISOString() }, org.token));
  assert.equal((await call('POST', '/holds', { ticketTypeId: vip.id, quantity: 1, accessCode: 'fans-first' }, fan.token)).status, 400);
  const later = await ok(call('POST', `/events/${ev.slug}/presale`, { code: 'fans-first' }));
  assert.deepEqual([later.ok, later.ticketTypeIds.length], [false, 0]);
  assert.equal((await ok(call('GET', `/events/${ev.slug}`))).presale.open, false);
  // No presale at all.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { presaleCode: '', presaleStartsAt: null }, org.token));
  assert.equal((await ok(call('GET', `/events/${ev.slug}`))).presale, null);
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}`, { presaleCode: 'no spaces' }, org.token)).status, 400);

  // Waiting for the on-sale: the waitlist tells them when it starts.
  await ok(call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id }, fan.token));
  assert.equal(await waitlist.release(ev.id), 0);
  // Sale windows: the end must come after the start; the organizer can move or clear them.
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { salesEnd: new Date(Date.now() + DAY).toISOString() }, org.token)).status, 400);
  await prisma.hold.updateMany({ where: { ticketTypeId: vip.id }, data: { status: 'RELEASED' } });
  await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { salesStart: new Date(Date.now() - 60_000).toISOString() }, org.token));
  assert.equal(await waitlist.release(ev.id), 1);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { kind: 'waitlist', to: fan.user.email } });
  assert.ok(mail.subject.startsWith('On sale now'));
  await ok(call('POST', '/holds', { ticketTypeId: vip.id, quantity: 1 }, fan.token));

  // Sales that have ended.
  await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${general.id}`, { salesEnd: new Date(Date.now() + 5 * DAY).toISOString() }, org.token));
  await prisma.ticketType.update({ where: { id: general.id }, data: { salesEnd: new Date(Date.now() - 1000) } });
  const ended = await call('POST', '/holds', { ticketTypeId: general.id, quantity: 1 }, fan.token);
  assert.equal(ended.status, 400);
  assert.match(ended.body.message, /ended/);
  assert.equal(((await ok(call('GET', `/events/${ev.slug}`))).ticketTypes as Json[]).find((t) => t.name === 'General')!.saleState, 'ENDED');
  const cleared = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${general.id}`, { salesEnd: null }, org.token));
  assert.equal(cleared.salesEnd, null);
});

test('questions at checkout: asked once or per ticket, required ones checked, shown with the attendees', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`ask-o1-${run}@test.local`, 'Quinn Organizer');
  const fan = await account(`ask-f1-${run}@test.local`, 'Finn Fan');
  const { ev, general, vip } = await show(org.token, admin.token, {
    minAge: 18,
    questions: [
      { label: 'Company', required: true },
      { label: 'T-shirt size', type: 'CHOICE', options: ['S', 'M', 'L'], required: true, per: 'TICKET' },
      { label: 'Dietary needs', per: 'TICKET' },
    ],
  });
  const page = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(page.minAge, 18);
  const qs = page.questions as Json[];
  assert.deepEqual(qs.map((q) => [q.label, q.type, q.required, q.per]), [['Company', 'TEXT', true, 'ORDER'], ['T-shirt size', 'CHOICE', true, 'TICKET'], ['Dietary needs', 'TEXT', false, 'TICKET']]);
  const [company, shirt, diet] = qs.map((q) => q.id as string);
  // Limits on what can be asked.
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}`, { questions: [{ label: 'Pick one', type: 'CHOICE', options: ['Only'] }] }, org.token)).status, 400);
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}`, { questions: Array.from({ length: 9 }, (_, i) => ({ label: `Question ${i}` })) }, org.token)).status, 400);

  const hold = await ok(call('POST', '/holds', { ticketTypeId: general.id, quantity: 2 }, fan.token));
  const seen = await ok(call('GET', `/holds/${hold.id}`));
  assert.equal(seen.questions.length, 3);
  assert.equal(seen.event.minAge, 18);
  const who = { holdId: hold.id, email: fan.user.email, name: fan.user.name };
  // Required answers are checked: once per order, and for each ticket.
  assert.equal((await call('POST', '/orders', who, fan.token)).status, 400);
  const partly = await call('POST', '/orders', { ...who, answers: [{ questionId: company, value: 'Acme' }, { questionId: shirt, value: 'M', ticket: 0 }] }, fan.token);
  assert.equal(partly.status, 400);
  assert.match(partly.body.message, /T-shirt size.*ticket 2/);
  assert.equal((await call('POST', '/orders', { ...who, answers: [{ questionId: company, value: 'Acme' }, { questionId: shirt, value: 'XXL', ticket: 0 }, { questionId: shirt, value: 'L', ticket: 1 }] }, fan.token)).status, 400);
  const order = await ok(
    call('POST', '/orders', { ...who, answers: [{ questionId: company, value: '  Acme   Ltd ' }, { questionId: shirt, value: 'M', ticket: 0 }, { questionId: shirt, value: 'L', ticket: 1 }, { questionId: diet, value: 'Vegan', ticket: 1 }, { questionId: 'unknown', value: 'x' }] }, fan.token),
  );
  await ok(call('POST', `/orders/${order.orderId}/pay`));
  const stored = (await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).answers as Json;
  assert.deepEqual(stored.order, [{ id: company, label: 'Company', value: 'Acme Ltd' }]);
  assert.deepEqual(stored.tickets.map((t: Json[]) => t.map((a) => a.value)), [['M'], ['L', 'Vegan']]);

  // The organizer sees each ticket's answers, and the CSV has a column per question.
  const people = (await ok(call('GET', `/organizer/events/${ev.id}/attendees`, undefined, org.token))) as Json[];
  assert.deepEqual(people.map((p) => p.answers.map((a: Json) => `${a.label}: ${a.value}`)), [['Company: Acme Ltd', 'T-shirt size: M'], ['Company: Acme Ltd', 'T-shirt size: L', 'Dietary needs: Vegan']]);
  const csv = (await call('GET', `/organizer/events/${ev.id}/attendees.csv`, undefined, org.token)).text;
  assert.match(csv.split('\n')[0], /"Company","T-shirt size","Dietary needs"/);
  assert.match(csv, /"Acme Ltd","L","Vegan"/);

  // A cart: per-ticket answers count across its lines; answers asked once go on every order.
  const cart = await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: general.id, quantity: 1 }, { ticketTypeId: vip.id, quantity: 1 }] }, fan.token));
  const holdIds = (cart.holds as Json[]).map((h) => h.id);
  const cartWho = { holdIds, email: fan.user.email, name: fan.user.name };
  assert.equal((await call('POST', '/orders/cart', { ...cartWho, answers: [{ questionId: company, value: 'Acme' }, { questionId: shirt, value: 'S', ticket: 0 }] }, fan.token)).status, 400);
  const made = await ok(call('POST', '/orders/cart', { ...cartWho, answers: [{ questionId: company, value: 'Acme' }, { questionId: shirt, value: 'S', ticket: 0 }, { questionId: shirt, value: 'L', ticket: 1 }] }, fan.token));
  const lines = await prisma.order.findMany({ where: { groupId: made.groupId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(lines.map((o) => [(o.answers as Json).order[0].value, (o.answers as Json).tickets[0][0].value]), [['Acme', 'S'], ['Acme', 'L']]);

  // Editing a question keeps its id; dropping them all stops the asking.
  const edited = await ok(call('PATCH', `/organizer/events/${ev.id}`, { questions: [{ id: company, label: 'Company or school' }, { label: 'How did you hear about us?' }] }, org.token));
  void edited;
  const after2 = (await ok(call('GET', `/events/${ev.slug}`))).questions as Json[];
  assert.deepEqual([after2[0].id, after2[0].label, after2.length, after2[0].required], [company, 'Company or school', 2, false]);
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { questions: [], minAge: null }, org.token));
  const none = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual([none.questions, none.minAge], [[], null]);
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: general.id, quantity: 1 }, fan.token));
  await ok(call('POST', '/orders', { holdId: h2.id, email: fan.user.email, name: fan.user.name }, fan.token));
});

test('report this event, and the calendar file', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rep-o1-${run}@test.local`, 'Rae Organizer');
  const fan = await account(`rep-f1-${run}@test.local`, 'Flo Fan');
  const { ev } = await show(org.token, admin.token);

  assert.equal((await call('POST', `/events/${ev.slug}/report`, { reason: 'OTHER' })).status, 400);
  assert.equal((await call('POST', `/events/${ev.slug}/report`, { reason: 'NONSENSE' })).status, 400);
  assert.equal((await call('POST', '/events/no-such-event/report', { reason: 'SCAM' })).status, 404);
  assert.equal((await ok(call('POST', `/events/${ev.slug}/report`, { reason: 'SCAM', details: 'The venue says nothing is booked that night.', email: 'Reporter@Example.com' }))).received, true);
  // The same person again adds nothing; someone signed in is another report.
  await ok(call('POST', `/events/${ev.slug}/report`, { reason: 'SCAM' }));
  await ok(call('POST', `/events/${ev.slug}/report`, { reason: 'WRONG_INFO', details: 'The start time on the poster is 8 PM.' }, fan.token));
  assert.equal(await prisma.eventReport.count({ where: { eventId: ev.id } }), 2);

  assert.equal((await call('GET', '/admin/event-reports', undefined, fan.token)).status, 403);
  const open = await ok(call('GET', '/admin/event-reports', undefined, admin.token));
  const ours = (open.reports as Json[]).filter((r) => r.eventId === ev.id);
  assert.equal(ours.length, 2);
  assert.deepEqual([ours[0].reason, ours[0].signedIn, ours[0].event.title, ours[0].openForEvent, ours[0].email], ['WRONG_INFO', true, ev.title, 2, fan.user.email]);
  assert.equal(ours[1].email, 'reporter@example.com');
  assert.ok(!('clientIp' in ours[0]));
  const done = await ok(call('POST', `/admin/event-reports/${ours[1].id}/resolve`, { action: 'DISMISS', note: 'Checked with the venue: it is booked.' }, admin.token));
  assert.equal(done.status, 'DISMISSED');
  assert.equal((await call('POST', `/admin/event-reports/${ours[1].id}/resolve`, { action: 'ACTIONED' }, admin.token)).status, 400);
  assert.equal(((await ok(call('GET', '/admin/event-reports', undefined, admin.token))).reports as Json[]).filter((r) => r.eventId === ev.id).length, 1);
  assert.equal(((await ok(call('GET', '/admin/event-reports?status=DISMISSED', undefined, admin.token))).reports as Json[]).filter((r) => r.eventId === ev.id).length, 1);
  assert.equal(await prisma.auditLog.count({ where: { action: 'event.report.dismissed', entityId: ev.id } }), 1);

  // The calendar file: one event, the venue's local time with its zone.
  const res = await fetch(`${base}/events/${ev.slug}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.ok(ics.includes(`SUMMARY:${ev.title}`));
  assert.match(ics, /DTSTART;TZID=Europe\/London:\d{8}T\d{6}\r\n/);
  assert.match(ics, /LOCATION:Sale Hall\\, 1 Sale St\\, London/);
  assert.equal((await fetch(`${base}/events/no-such-event/calendar.ics`)).status, 404);
});
