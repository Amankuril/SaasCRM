import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { clearPlatformSettingsCache } from '../src/modules/admin/admin.service.js';
import { PlatformSettings } from '../src/modules/admin/admin.model.js';
import { User } from '../src/modules/auth/user.model.js';
import { Invoice } from '../src/modules/billing/billing.model.js';
import { SandboxBillingProvider, setBillingProvider } from '../src/modules/billing/provider.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { CATEGORIES, categoryOf } from '../src/modules/reminders/categories.js';
import { FeatureUnlock, ReminderRecord, ReminderSend, ReminderSetup } from '../src/modules/reminders/reminder.model.js';
import { tickReminders } from '../src/modules/reminders/reminder.service.js';
import { nextRun, occurrence, parseDate, parseTime, runsBetween, zonedToUtc, type ScheduleInput } from '../src/modules/reminders/schedule.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, failWith } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const TZ = 'Asia/Kolkata';
let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
  setBillingProvider(new SandboxBillingProvider());
  clearPlatformSettingsCache();
});
afterEach(() => {
  setWhatsAppProvider(undefined);
  setBillingProvider(undefined);
  clearPlatformSettingsCache();
});

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
let phone = 810000000;
async function ready() {
  const owner = await signup();
  const ws = await createWorkspace(owner, 'Sharma Dental');
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: String(phone++), accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  const template = await MessageTemplate.create({ workspaceId: ws.id, name: 'due', language: 'en', category: 'UTILITY', status: 'APPROVED', providerTemplateId: 't1', components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} is due on {{3}}.' }] });
  return { owner, ws, as: auth(owner), base: `/api/workspaces/${ws.id}/reminders`, template };
}
const field = (value: string, fallback?: string) => ({ source: 'field', value, ...(fallback ? { fallback } : {}) });
async function setupOf(r: Awaited<ReturnType<typeof ready>>, category: string, patch: object = {}) {
  const { body } = await api().post(`${r.base}/setups`).set(r.as).send({ category }).expect(201);
  const id = body.setup.id as string;
  await api().patch(`${r.base}/setups/${id}`).set(r.as).send({ templateId: r.template.id, bodyVariables: [field('name', 'there'), field('amount', 'A payment'), field('date')], sendTime: '10:00', ...patch }).expect(200);
  return id;
}
const add = (r: Awaited<ReturnType<typeof ready>>, id: string, body: object) => api().post(`${r.base}/setups/${id}/records`).set(r.as).send(body);
const activate = (r: Awaited<ReturnType<typeof ready>>, id: string) => api().post(`${r.base}/setups/${id}/activate`).set(r.as).send({});
/** "YYYY-MM-DD" n days from now in the workspace timezone. */
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 86_400_000));
const at = (date: string, time = '10:00') => new Date(zonedToUtc(date, time, TZ).getTime() + 60_000);

describe('reminder schedule maths', () => {
  const base: ScheduleInput = { eventDate: '2026-01-31', eventTime: null, recurrence: 'monthly', everyDays: 30, sendTime: '10:00', rules: [{ when: 'before', value: 1, unit: 'day' }, { when: 'after', value: 3, unit: 'day' }], endDate: null, maxCycles: null, doneThrough: null, timeZone: TZ };

  it('keeps the same day each cycle, including short months and leap birthdays', () => {
    expect([0, 1, 2, 3].map((k) => occurrence('2026-01-31', 'monthly', k))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect([1, 4].map((k) => occurrence('2024-02-29', 'yearly', k))).toEqual(['2025-02-28', '2028-02-29']);
    expect(occurrence('2026-01-01', 'custom_days', 2, 45)).toBe('2026-04-01');
  });

  it('converts wall-clock times across daylight saving', () => {
    expect(zonedToUtc('2026-12-01', '10:00', TZ).toISOString()).toBe('2026-12-01T04:30:00.000Z');
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('finds the next run across cycles, follow-ups, done marks and limits', () => {
    const after = new Date('2026-02-01T00:00:00Z');
    expect(nextRun(base, after)).toMatchObject({ ruleId: 'after-3-day', occurrence: '2026-01-31' });
    expect(nextRun({ ...base, doneThrough: '2026-01-31' }, after)).toMatchObject({ ruleId: 'before-1-day', occurrence: '2026-02-28', cycle: 1 });
    expect(nextRun({ ...base, maxCycles: 1, doneThrough: '2026-01-31' }, after)).toBeNull();
    expect(nextRun({ ...base, endDate: '2026-02-15', doneThrough: '2026-01-31' }, after)).toBeNull();
    // A birthday from decades ago is found without walking every year.
    expect(nextRun({ ...base, eventDate: '1961-08-14', recurrence: 'yearly', rules: [{ when: 'on', value: 0, unit: 'day' }] }, new Date('2026-08-15T00:00:00Z'))).toMatchObject({ occurrence: '2027-08-14', cycle: 66 });
    expect(runsBetween(base, new Date('2026-01-30T00:00:00Z'), new Date('2026-03-04T00:00:00Z')).map((r) => `${r.occurrence} ${r.ruleId}`)).toEqual(['2026-01-31 before-1-day', '2026-01-31 after-3-day', '2026-02-28 before-1-day', '2026-02-28 after-3-day']);
  });

  it('reads the date and time formats people put in spreadsheets', () => {
    expect(['2026-12-01', '01/12/2026', '1-12-26', '1 Dec 2026', 'Dec 1, 2026', '1st December 2026', '46357'].map((d) => parseDate(d))).toEqual(Array(7).fill('2026-12-01'));
    expect(parseDate('12/01/2026', 'mdy')).toBe('2026-12-01');
    expect([parseDate('31/02/2026'), parseDate('hello'), parseDate('14/08')]).toEqual([null, null, null]);
    expect(parseDate('14/08', 'dmy', true)).toBe('1904-08-14');
    expect(['14:30', '2:30 PM', '2.30 pm', '0.6041666', '1430'].map(parseTime).filter((t) => t === '14:30').length).toBeGreaterThanOrEqual(4);
    expect([parseTime('25:00'), parseTime('abc')]).toEqual([null, null]);
  });
});

describe('date reminders', () => {
  it('lists eleven separate categories and keeps their timing rules apart', async () => {
    const r = await ready();
    const { body } = await api().get(r.base).set(r.as).expect(200);
    expect(body.categories.map((c: { key: string }) => c.key)).toEqual(CATEGORIES.map((c) => c.key));
    expect(body.categories).toHaveLength(11);
    const birthday = (await api().post(`${r.base}/setups`).set(r.as).send({ category: 'birthdays' }).expect(201)).body.setup;
    const payment = (await api().post(`${r.base}/setups`).set(r.as).send({ category: 'payments' }).expect(201)).body.setup;
    expect(payment.rules).toEqual([{ when: 'before', value: 1, unit: 'day' }, { when: 'after', value: 3, unit: 'day' }]);
    expect(birthday.fields.map((f: { key: string }) => f.key)).not.toContain('amount');
    const patch = (id: string, b: object) => api().patch(`${r.base}/setups/${id}`).set(r.as).send(b);
    await patch(birthday.id, { recurrence: 'monthly' }).expect(400);
    await patch(birthday.id, { rules: [{ when: 'before', value: 1, unit: 'hour' }] }).expect(400);
    await patch(birthday.id, { rules: [{ when: 'after', value: 1, unit: 'day' }] }).expect(400);
    await patch(payment.id, { extraFields: [{ key: 'x', label: 'X' }] }).expect(400);
    const appt = (await api().post(`${r.base}/setups`).set(r.as).send({ category: 'appointments' }).expect(201)).body.setup;
    expect(appt.rules).toContainEqual({ when: 'before', value: 1, unit: 'hour' });
    // Changing one leaves the other alone.
    await patch(payment.id, { sendTime: '18:30' }).expect(200);
    expect((await api().get(`${r.base}/setups/${birthday.id}`).set(r.as)).body.setup.sendTime).toBe('10:00');
  });

  it('needs an approved template, every value and a contact before it can go live', async () => {
    const r = await ready();
    const id = (await api().post(`${r.base}/setups`).set(r.as).send({ category: 'payments' }).expect(201)).body.setup.id;
    let res = await activate(r, id);
    expect(Object.keys(res.body.error.details)).toEqual(expect.arrayContaining(['templateId', 'contacts']));
    await api().patch(`${r.base}/setups/${id}`).set(r.as).send({ templateId: r.template.id, bodyVariables: [field('name'), field('amount'), field('date')] }).expect(200);
    await add(r, id, { phone: '98111 22223', name: 'Rahul', date: day(5), fields: {} }).expect(400);
    await add(r, id, { phone: '98111 22223', name: 'Rahul', date: day(5), fields: { amount: '₹4,500', invoice_number: 'INV-1' } }).expect(201);
    expect((await add(r, id, { phone: '+919811122223', name: 'Rahul', date: day(9), fields: { amount: '₹1', invoice_number: 'inv-1' } })).body.error.code).toBe('RECORD_EXISTS');
    await MessageTemplate.updateOne({ workspaceId: r.ws.id, _id: r.template._id }, { status: 'PENDING' });
    res = await activate(r, id);
    expect(res.body.error.details.templateId[0]).toContain('pending');
    await MessageTemplate.updateOne({ workspaceId: r.ws.id, _id: r.template._id }, { status: 'APPROVED' });

    const preview = (await api().get(`${r.base}/setups/${id}/preview`).set(r.as).expect(200)).body;
    expect(preview.bodyParams.slice(0, 2)).toEqual(['Rahul', '₹4,500']);
    expect(preview).toMatchObject({ contacts: 1, missing: [] });
    expect(new Date(preview.nextRunAt).toISOString()).toBe(zonedToUtc(day(4), '10:00', TZ).toISOString());
    expect((await activate(r, id)).body.setup).toMatchObject({ status: 'active', counts: { contacts: 1, active: 1 } });
  });

  it('sends once per event, repeats on the next cycle, and never duplicates even after delete and re-import', async () => {
    const r = await ready();
    const id = await setupOf(r, 'installments', { rules: [{ when: 'on', value: 0, unit: 'day' }] });
    const due = day(2);
    const body = { phone: '+919811122223', name: 'Rahul Verma', date: due, fields: { amount: '₹12,000', account_number: 'LN-1' } };
    const rec = (await add(r, id, body).expect(201)).body.record;
    await activate(r, id).expect(200);

    expect(await tickReminders(new Date())).toEqual({ due: 0, sent: 0 });
    expect(await tickReminders(at(due))).toEqual({ due: 1, sent: 1 });
    for (let i = 0; i < 3; i++) expect((await tickReminders(at(due, '10:05'))).sent).toBe(0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.message).toMatchObject({ type: 'template', template: { name: 'due', bodyParams: ['Rahul Verma', '₹12,000', expect.any(String)] } });

    const after = (await api().get(`${r.base}/setups/${id}/records`).set(r.as)).body.records[0];
    expect(after.nextOccurrence).toBe(occurrence(due, 'monthly', 1));
    // Pretend the pointer was rolled back (crash): the log still refuses a second send.
    await ReminderRecord.updateOne({ workspaceId: r.ws.id, _id: rec.id }, { nextRunAt: zonedToUtc(due, '10:00', TZ) });
    expect((await tickReminders(at(due, '10:10'))).sent).toBe(0);
    await api().delete(`${r.base}/setups/${id}/records/${rec.id}`).set(r.as).expect(204);
    const again = (await add(r, id, body).expect(201)).body.record;
    await ReminderRecord.updateOne({ workspaceId: r.ws.id, _id: again.id }, { nextRunAt: zonedToUtc(due, '10:00', TZ) });
    expect((await tickReminders(at(due, '10:15'))).sent).toBe(0);

    const second = occurrence(due, 'monthly', 1);
    expect((await tickReminders(at(second))).sent).toBe(1);
    expect(fake.sent).toHaveLength(2);
    expect((await ReminderSend.find({ workspaceId: r.ws.id, status: 'sent' }).sort({ scheduledFor: 1 })).map((s) => s.cycle)).toEqual([0, 1]);
  });

  it('reminds an hour before an appointment, and not after it has started', async () => {
    const r = await ready();
    const id = await setupOf(r, 'appointments', { bodyVariables: [field('name'), field('service', 'Your visit'), field('time')] });
    const date = day(3);
    expect((await add(r, id, { phone: '+919811122223', name: 'Priya', date, time: '' }).expect(400)).body.error.details).toHaveProperty('time');
    await add(r, id, { phone: '+919811122223', name: 'Priya', date, time: '4:30 PM', fields: { service: 'Cleaning' } }).expect(201);
    await add(r, id, { phone: '+919811122224', name: 'Late', date, time: '09:00' }).expect(201);
    await activate(r, id).expect(200);
    await tickReminders(at(day(2), '10:00'));
    expect(fake.sent).toHaveLength(2);
    // Worker was down from before 08:00 until 12:00: the 9:00 patient must not get "in an hour".
    await tickReminders(at(date, '12:00'));
    expect(fake.sent).toHaveLength(2);
    await tickReminders(at(date, '15:30'));
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]!.message).toMatchObject({ to: '+919811122223', template: { bodyParams: ['Priya', 'Cleaning', '4:30 PM'] } });
    const logs = (await api().get(`${r.base}/setups/${id}/logs?status=skipped`).set(r.as).expect(200)).body;
    expect(logs.logs[0]).toMatchObject({ name: 'Late', status: 'skipped' });
    expect((await api().get(`${r.base}/setups/${id}/records?status=completed`).set(r.as)).body.total).toBe(2);
  });

  it('stops follow-ups once paid, pauses and resumes, and skips opted-out contacts', async () => {
    const r = await ready();
    const id = await setupOf(r, 'payments', { recurrence: 'none' });
    const due = day(2);
    const paid = (await add(r, id, { phone: '+919811122223', name: 'Paid', date: due, fields: { amount: '1' } }).expect(201)).body.record;
    await add(r, id, { phone: '+919811122224', name: 'Unpaid', date: due, fields: { amount: '2' } }).expect(201);
    const paused = (await add(r, id, { phone: '+919811122225', name: 'Paused', date: due, fields: { amount: '3' } }).expect(201)).body.record;
    await Contact.create({ workspaceId: r.ws.id, phoneE164: '+919811122226', consent: { status: 'opted_out' } });
    await add(r, id, { phone: '+919811122226', name: 'Opted out', date: due, fields: { amount: '4' } }).expect(201);
    await activate(r, id).expect(200);
    await api().post(`${r.base}/setups/${id}/records/${paused.id}/pause`).set(r.as).expect(200);

    await tickReminders(at(day(1)));
    expect(fake.sent.map((s) => s.message.to).sort()).toEqual(['+919811122223', '+919811122224']);
    await api().post(`${r.base}/setups/${id}/records/${paid.id}/done`).set(r.as).send({}).expect(200);
    await api().post(`${r.base}/setups/${id}/records/${paused.id}/resume`).set(r.as).expect(200);
    await tickReminders(at(day(5)));
    expect(fake.sent.slice(2).map((s) => s.message.to).sort()).toEqual(['+919811122224', '+919811122225']);
    const skipped = (await api().get(`${r.base}/setups/${id}/logs?status=skipped`).set(r.as)).body.logs;
    expect(skipped.filter((l: { name: string }) => l.name === 'Opted out').map((l: { error: string }) => l.error)).toContain('This contact has opted out of WhatsApp messages.');

    // Pausing the setup stops everything.
    await api().post(`${r.base}/setups/${id}/pause`).set(r.as).expect(200);
    expect(await ReminderRecord.countDocuments({ workspaceId: r.ws.id, nextRunAt: { $ne: null } })).toBe(0);
  });

  it('waits while the template is not approved, sends once it is, and reports useful failures', async () => {
    const r = await ready();
    const id = await setupOf(r, 'payments', { recurrence: 'none', rules: [{ when: 'on', value: 0, unit: 'day' }], bodyVariables: [field('name'), field('invoice_number'), field('date')] });
    const due = day(1);
    await add(r, id, { phone: '+919811122223', name: 'Has number', date: due, fields: { amount: '1', invoice_number: 'INV-9' } }).expect(201);
    await add(r, id, { phone: '+919811122224', name: 'No number', date: due, fields: { amount: '1' } }).expect(201);
    await activate(r, id).expect(200);
    await MessageTemplate.updateOne({ workspaceId: r.ws.id, _id: r.template._id }, { status: 'PAUSED' });
    expect((await tickReminders(at(due))).sent).toBe(0);
    let logs = (await api().get(`${r.base}/setups/${id}/logs`).set(r.as)).body;
    expect(logs.logs[0]).toMatchObject({ status: 'pending' });
    expect(logs.logs[0].error).toContain('paused on WhatsApp');
    await MessageTemplate.updateOne({ workspaceId: r.ws.id, _id: r.template._id }, { status: 'APPROVED' });
    expect((await tickReminders(at(due, '10:10'))).sent).toBe(1);
    logs = (await api().get(`${r.base}/setups/${id}/logs?status=failed`).set(r.as)).body;
    expect(logs.logs[0].error).toBe('Missing Invoice number for this contact. Add it, or set a fallback.');
    // Fixed and retried by hand.
    const rec = await ReminderRecord.findOne({ workspaceId: r.ws.id, name: 'No number' });
    await api().patch(`${r.base}/setups/${id}`).set(r.as).send({ bodyVariables: [field('name'), field('invoice_number', 'your invoice'), field('date')] }).expect(200);
    expect(rec).toBeTruthy();
    await api().post(`${r.base}/setups/${id}/logs/${logs.logs[0].id}/retry`).set(r.as).expect(200);
    expect((await tickReminders(new Date())).sent).toBe(1);
    expect((await api().get(`${r.base}/setups/${id}/logs`).set(r.as)).body.counts).toMatchObject({ sent: 2, failed: 0 });
  });

  it('counts a delivery failure as failed, with the reason, and can send it again', async () => {
    const r = await ready();
    const id = await setupOf(r, 'payments', { recurrence: 'none', rules: [{ when: 'on', value: 0, unit: 'day' }] });
    await add(r, id, { phone: '+919811122223', name: 'Rahul', date: day(1), fields: { amount: '1' } }).expect(201);
    await activate(r, id).expect(200);
    fake.nextSend(failWith('permanent', '131026', 'Message undeliverable'));
    await tickReminders(at(day(1)));
    const logs = (await api().get(`${r.base}/setups/${id}/logs`).set(r.as)).body;
    expect(logs.counts).toMatchObject({ sent: 0, failed: 1 });
    expect(logs.logs[0]).toMatchObject({ status: 'failed', error: 'Message undeliverable', retryable: true });
    await api().post(`${r.base}/setups/${id}/logs/${logs.logs[0].id}/retry`).set(r.as).expect(200);
    await tickReminders(new Date());
    expect((await api().get(`${r.base}/setups/${id}/logs`).set(r.as)).body.counts).toMatchObject({ sent: 1, failed: 0 });
    expect(fake.sent).toHaveLength(2);
  });

  it('imports a file with field mapping: checks first, reports bad rows, skips duplicates', async () => {
    const r = await ready();
    const id = await setupOf(r, 'birthdays', { bodyVariables: [field('name'), field('offer', 'A gift'), field('date')] });
    const rows = [
      { Mobile: '9811122223', Customer: 'Rahul', DOB: '14/08/1990', Gift: '20% off' },
      { Mobile: '9811122224', Customer: 'Priya', DOB: '3 Sep' },
      { Mobile: '9811122224', Customer: 'Priya', DOB: '3 Sep' },
      { Mobile: '123', Customer: 'Bad phone', DOB: '01/01/2000' },
      { Mobile: '9811122226', Customer: 'Bad date', DOB: '45/45/2000' },
    ].map((x) => ({ Gift: '', ...x }));
    const payload = { rows, mapping: { phone: 'Mobile', name: 'Customer', date: 'DOB', fields: { offer: 'Gift' } } };
    const send = (extra: object) => api().post(`${r.base}/setups/${id}/import`).set(r.as).send({ ...payload, ...extra });
    const dry = (await send({ dryRun: true }).expect(200)).body.report;
    expect(dry).toMatchObject({ total: 5, valid: 2, created: 0 });
    expect(dry.invalid.map((i: { row: number }) => i.row)).toEqual([4, 5, 6]);
    expect(await ReminderRecord.countDocuments({ workspaceId: r.ws.id })).toBe(0);
    expect((await send({}).expect(200)).body.report).toMatchObject({ created: 2 });
    expect((await send({}).expect(200)).body.report).toMatchObject({ created: 0, duplicates: 2 });
    const records = (await api().get(`${r.base}/setups/${id}/records`).set(r.as)).body.records;
    expect(records.map((x: { name: string; eventDateLabel: string }) => `${x.name} ${x.eventDateLabel}`).sort()).toEqual(['Priya 3 Sep', 'Rahul 14 Aug 1990']);
    expect(records.every((x: { nextOccurrence: string }) => /^20\d\d-/.test(x.nextOccurrence))).toBe(true);
  });

  it('supports custom event types with their own fields', async () => {
    const r = await ready();
    const { body } = await api().post(`${r.base}/setups`).set(r.as).send({ category: 'custom', eventLabel: 'Car service due' }).expect(201);
    const id = body.setup.id;
    await api().patch(`${r.base}/setups/${id}`).set(r.as).send({ extraFields: [{ key: 'vehicle', label: 'Vehicle' }], templateId: r.template.id, bodyVariables: [field('name'), field('vehicle'), field('date')] }).expect(200);
    await add(r, id, { phone: '+919811122223', name: 'Rahul', date: day(4), fields: { vehicle: 'MH01 AB 1234' } }).expect(201);
    await activate(r, id).expect(200);
    await tickReminders(at(day(3)));
    expect(fake.sent[0]!.message).toMatchObject({ template: { bodyParams: ['Rahul', 'MH01 AB 1234', expect.any(String)] } });
  });

  it('charges the one-time unlock exactly as configured by the admin', async () => {
    const r = await ready();
    const admin = await signup();
    await User.updateOne({ _id: admin.id }, { isPlatformAdmin: true });
    const settings = (b: object) => api().patch('/api/admin/settings').set(auth(admin)).send(b);
    await settings({ dateReminders: { paid: true, price: 0 } }).expect(400);
    const saved = await settings({ dateReminders: { paid: true, price: 149_900, comparePrice: 249_900, benefits: ['No subscription'], buttonLabel: 'Unlock' } }).expect(200);
    expect(saved.body.settings.dateReminders).toMatchObject({ price: 149_900, discountPercent: 40 });

    const { body } = await api().get(r.base).set(r.as).expect(200);
    expect(body.access).toMatchObject({ unlocked: false, offer: { price: 149_900, buttonLabel: 'Unlock' } });
    expect((await api().post(`${r.base}/setups`).set(r.as).send({ category: 'birthdays' }).expect(402)).body.error.code).toBe('FEATURE_LOCKED');

    const order = (await api().post(`${r.base}/unlock`).set(r.as).expect(200)).body.order;
    expect(order.amount).toBe(149_900);
    await api().post(`${r.base}/unlock/sandbox`).set(r.as).expect(200);
    expect(await Invoice.countDocuments({ workspaceId: r.ws.id, planCode: 'date_reminders', amount: 149_900 })).toBe(1);
    await api().post(`${r.base}/setups`).set(r.as).send({ category: 'birthdays' }).expect(201);
    // "All businesses": the same owner's second workspace is unlocked too, strangers are not.
    const second = await createWorkspace(r.owner, 'Second');
    await api().post(`/api/workspaces/${second.id}/reminders/setups`).set(r.as).send({ category: 'offers' }).expect(201);
    const other = await ready();
    await api().post(`${other.base}/setups`).set(other.as).send({ category: 'offers' }).expect(402);
    await api().post(`/api/admin/workspaces/${other.ws.id}/date-reminders`).set(auth(admin)).send({ unlocked: true }).expect(200);
    await api().post(`${other.base}/setups`).set(other.as).send({ category: 'offers' }).expect(201);
    expect(await FeatureUnlock.countDocuments({ workspaceId: r.ws.id })).toBe(1);
    await PlatformSettings.updateOne({ key: 'platform' }, { 'dateReminders.paid': false });
  });

  it('is private to the workspace and respects roles', async () => {
    const r = await ready();
    const id = await setupOf(r, 'offers', { bodyVariables: [field('name'), field('offer'), field('date')] });
    const stranger = await ready();
    await api().get(`${stranger.base}/setups/${id}`).set(stranger.as).expect(404);
    const agent = await signup();
    await addMember(r.owner, r.ws.id, agent, 'agent');
    await api().get(`${r.base}/setups/${id}`).set(auth(agent)).expect(200);
    await api().post(`${r.base}/setups/${id}/pause`).set(auth(agent)).expect(403);
    expect(await ReminderSetup.countDocuments({ workspaceId: new Types.ObjectId(r.ws.id) })).toBe(1);
    expect(categoryOf('offers').followUps).toBe(false);
  });
});
