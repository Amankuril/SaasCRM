import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { Message } from '../src/modules/messages/message.model.js';
import { processSequenceRun, retrySequenceMessage, tickSequences } from '../src/modules/sequences/sequence.engine.js';
import { runDailyTriggers } from '../src/modules/sequences/sequence.daily.js';
import { Sequence, SequenceEnrollment, SequenceEvent, SequenceMessage } from '../src/modules/sequences/sequence.model.js';
import { isoWeekday, nextSendTime, resolveVariable } from '../src/modules/sequences/sequence.rules.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundPayload, sign, statusPayload } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

function postWebhook(payload: unknown) {
  const body = JSON.stringify(payload);
  return api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
}

const tpl = (name: string, text: string, category = 'MARKETING') => ({ providerTemplateId: `tpl-${name}`, name, language: 'en', category, status: 'APPROVED', rejectedReason: null, components: [{ type: 'BODY' as const, text }] });

/** Fast, deterministic rules for tests: no quiet hours, high daily cap. */
const OPEN_RULES = { quietHours: { enabled: false, start: '21:00', end: '09:00' }, maxPerContactPerDay: 20 };

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  fake.templates = [tpl('welcome', 'Hi {{1}}, welcome to our clinic!'), tpl('offer', 'Special offer for you'), tpl('reminder', 'Reminder: see you on {{1}}', 'UTILITY')];
  await api().post(`${base}/templates/sync`).set(auth(owner)).expect(200);
  const t = async (name: string) => String((await MessageTemplate.findOne({ workspaceId: ws.id, name }))!._id);
  const templates = { welcome: await t('welcome'), offer: await t('offer'), reminder: await t('reminder') };
  const tag = async (name: string) => (await api().post(`${base}/tags`).set(auth(owner)).send({ name }).expect(201)).body.tag.id as string;
  const contact = async (phone: string, body: object = {}) => (await api().post(`${base}/contacts`).set(auth(owner)).send({ phone, ...body }).expect(201)).body.contact;
  return { owner, ws, base, seqs: `${base}/sequences`, templates, tag, contact };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const msg = (id: string, templateId: string, body: object[] = [], extra: object = {}) => ({ id, type: 'message', templateId, headerVariables: [], bodyVariables: body, ...extra });
const nameVar = { source: 'contact', value: 'first_name', fallback: 'there' };

async function createSequence(ctx: Ctx, patch: Record<string, unknown>, publish = true) {
  const created = await api().post(ctx.seqs).set(auth(ctx.owner)).send({ name: 'Test sequence' }).expect(201);
  const id = created.body.sequence.id as string;
  await api().patch(`${ctx.seqs}/${id}`).set(auth(ctx.owner)).send({ rules: OPEN_RULES, ...patch }).expect(200);
  if (publish) await api().post(`${ctx.seqs}/${id}/publish`).set(auth(ctx.owner)).expect(200);
  return id;
}

/** Makes every live enrollment due now and runs the scheduler. */
async function advance() {
  await SequenceEnrollment.updateMany({ active: true }, { nextRunAt: new Date(Date.now() - 1000) }).setOptions({ skipTenantScope: true });
  await tickSequences(new Date());
}

const sentTexts = () => fake.sent.map((s) => (s.message.type === 'template' ? s.message.template.name : s.message.type === 'text' ? `text:${s.message.text}` : s.message.type));

describe('send window and variables', () => {
  const rules = { quietHours: { enabled: true, start: '21:00', end: '09:00' }, days: [1, 2, 3, 4, 5] };
  it('waits for the morning, skips weekends', () => {
    // Wed 2026-11-25 22:30 IST -> Thu 09:00 IST (03:30 UTC).
    expect(nextSendTime(new Date('2026-11-25T17:00:00Z'), rules, 'Asia/Kolkata').toISOString()).toBe('2026-11-26T03:30:00.000Z');
    // Inside the window: now.
    const noon = new Date('2026-11-25T06:30:00Z');
    expect(nextSendTime(noon, rules, 'Asia/Kolkata')).toBe(noon);
    // Fri 22:00 IST -> Mon 09:00 IST.
    expect(nextSendTime(new Date('2026-11-27T16:30:00Z'), rules, 'Asia/Kolkata').toISOString()).toBe('2026-11-30T03:30:00.000Z');
    expect(isoWeekday('2026-11-30')).toBe(1);
  });

  it('uses the fallback, else reports missing', () => {
    const contact = { id: 'x', name: null, profileName: null, phoneE164: '+919800000000', email: null, tags: [], lifecycleStage: 'new', customFields: { city: 'Indore' } };
    expect(resolveVariable({ source: 'contact', value: 'first_name', fallback: 'there' }, contact, {}, 'Asia/Kolkata')).toBe('there');
    expect(resolveVariable({ source: 'field', value: 'city', fallback: '' }, contact, {}, 'Asia/Kolkata')).toBe('Indore');
    expect(resolveVariable({ source: 'data', value: 'order_no', fallback: '' }, contact, { order_no: 42 }, 'Asia/Kolkata')).toBe('42');
    expect(resolveVariable({ source: 'data', value: 'plan', fallback: '' }, contact, {}, 'Asia/Kolkata')).toBeNull();
  });
});

describe('sequences', () => {
  it('blocks publishing until things left are done, then locks the trigger', async () => {
    const ctx = await setup();
    const created = await api().post(ctx.seqs).set(auth(ctx.owner)).send({ name: 'Onboarding' }).expect(201);
    const id = created.body.sequence.id;
    expect(created.body.sequence.checklist.map((i: { key: string }) => i.key)).toEqual(expect.arrayContaining(['trigger', 'steps']));
    const blocked = await api().post(`${ctx.seqs}/${id}/publish`).set(auth(ctx.owner)).expect(422);
    expect(blocked.body.error.code).toBe('SEQUENCE_NOT_READY');

    // Template with {{1}} but no variable mapped.
    const patched = await api()
      .patch(`${ctx.seqs}/${id}`)
      .set(auth(ctx.owner))
      .send({ trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.welcome)] } })
      .expect(200);
    expect(patched.body.sequence.checklist).toEqual([expect.objectContaining({ key: 'variables', stepId: 'm1' })]);
    await api().patch(`${ctx.seqs}/${id}`).set(auth(ctx.owner)).send({ draftGraph: { steps: [msg('m1', ctx.templates.welcome, [nameVar])] } }).expect(200);
    const live = await api().post(`${ctx.seqs}/${id}/publish`).set(auth(ctx.owner)).expect(200);
    expect(live.body.sequence).toMatchObject({ status: 'active', published: true, checklist: [], live: { versionNo: 1 } });

    const locked = await api().patch(`${ctx.seqs}/${id}`).set(auth(ctx.owner)).send({ trigger: { type: 'new_contact' } }).expect(409);
    expect(locked.body.error.code).toBe('TRIGGER_LOCKED');

    // Agents can look but not change.
    const agent = await signup({ email: 'agent@example.com' });
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    await api().get(`${ctx.seqs}/${id}`).set(auth(agent)).expect(200);
    await api().post(`${ctx.seqs}/${id}/pause`).set(auth(agent)).expect(403);
  });

  it('a tag starts the sequence: message now, wait, next message; then completes', async () => {
    const ctx = await setup();
    const vip = await ctx.tag('VIP');
    const id = await createSequence(ctx, {
      trigger: { type: 'tag_added', tagIds: [vip] },
      draftGraph: { steps: [msg('m1', ctx.templates.welcome, [nameVar]), { id: 'w1', type: 'wait', amount: 2, unit: 'days' }, msg('m2', ctx.templates.offer)] },
    });
    const c = await ctx.contact('+919811112222', { name: 'Ravi Kumar' });
    // A tag added before publish does not count (no back-fill); this one does.
    await api().patch(`${ctx.base}/contacts/${c.id}`).set(auth(ctx.owner)).send({ tags: [vip] }).expect(200);

    expect(sentTexts()).toEqual(['welcome']);
    expect(fake.sent[0]!.message.type === 'template' && fake.sent[0]!.message.template.bodyParams).toEqual(['Ravi']);
    const e = await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id, sequenceId: id });
    expect(e).toMatchObject({ status: 'in_progress', currentStepId: 'm2', joinedVia: 'trigger:tag_added' });
    const twoDays = e!.nextRunAt!.getTime() - Date.now();
    expect(twoDays).toBeGreaterThan(2 * 86_400_000 - 60_000);
    expect((await Message.findOne({ workspaceId: ctx.ws.id, direction: 'outbound' }))!.source).toBe('sequence');

    // Not due yet: nothing happens.
    await tickSequences();
    expect(fake.sent).toHaveLength(1);
    await advance();
    expect(sentTexts()).toEqual(['welcome', 'offer']);
    const done = await SequenceEnrollment.findOne({ _id: e!._id, workspaceId: ctx.ws.id });
    expect(done).toMatchObject({ status: 'completed', outcome: 'completed', active: false });

    // Joins once: the tag again does nothing.
    await api().patch(`${ctx.base}/contacts/${c.id}`).set(auth(ctx.owner)).send({ tags: [] }).expect(200);
    await api().patch(`${ctx.base}/contacts/${c.id}`).set(auth(ctx.owner)).send({ tags: [vip] }).expect(200);
    expect(await SequenceEnrollment.countDocuments({ workspaceId: ctx.ws.id, sequenceId: id })).toBe(1);

    const list = await api().get(ctx.seqs).set(auth(ctx.owner)).expect(200);
    expect(list.body.sequences[0].counts).toMatchObject({ completed: 1, inProgress: 0 });
    expect(list.body.usage.used).toBe(1);
    const history = await api().get(`${ctx.seqs}/${id}/contacts/${e!.id}`).set(auth(ctx.owner)).expect(200);
    expect(history.body.history.map((h: { type: string; result: string }) => `${h.type}:${h.result}`)).toEqual(['enrolled:joined', 'message:sent', 'wait:waiting', 'message:sent', 'exited:completed']);
  });

  it('STOP exits every sequence within one tick and blocks future joins', async () => {
    const ctx = await setup();
    const a = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m2', ctx.templates.offer)] } });
    const b = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m2', ctx.templates.offer)] } });
    for (const s of [a, b]) await api().post(`${ctx.seqs}/${s}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    expect(fake.sent).toHaveLength(2);

    await postWebhook(inboundPayload(PHONE_ID, { id: 'wamid.stop', from: '919811112222', text: 'STOP' })).expect(200);
    const rows = await SequenceEnrollment.find({ workspaceId: ctx.ws.id });
    expect(rows.map((r) => r.outcome)).toEqual(['opted_out', 'opted_out']);
    await advance();
    expect(fake.sent).toHaveLength(2);
    const again = await api().post(`${ctx.seqs}/${a}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    expect(again.body.results.opted_out).toBe(1);
  });

  it('a goal tag added by API stops the next reminder even when it is due', async () => {
    const ctx = await setup();
    const upgraded = await ctx.tag('upgraded');
    const id = await createSequence(ctx, {
      trigger: { type: 'manual' },
      goal: { type: 'tag_added', tagIds: [upgraded] },
      draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'minutes' }, msg('m2', ctx.templates.offer)] },
    });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811113333'] }).expect(200);
    // Due right now…
    await SequenceEnrollment.updateMany({ workspaceId: ctx.ws.id }, { nextRunAt: new Date(Date.now() - 1000) });
    // …but the goal arrives first (event-driven exit).
    const contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919811113333' });
    contact!.tags.push(new Types.ObjectId(upgraded));
    await contact!.save();
    await tickSequences();
    expect(fake.sent).toHaveLength(1);
    expect(await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id })).toMatchObject({ status: 'completed', outcome: 'completed_goal' });
  });

  it('even without the event, the goal is re-checked right before a send', async () => {
    const ctx = await setup();
    const paid = await ctx.tag('Paid');
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, goal: { type: 'tag_added', tagIds: [paid] }, draftGraph: { steps: [{ id: 'w1', type: 'wait', amount: 1, unit: 'hours' }, msg('m1', ctx.templates.offer)] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811114444'] }).expect(200);
    // Written straight to the database: no event.
    await Contact.updateOne({ workspaceId: ctx.ws.id, phoneE164: '+919811114444' }, { $addToSet: { tags: new Types.ObjectId(paid) } });
    await advance();
    expect(fake.sent).toHaveLength(0);
    expect((await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id }))!.outcome).toBe('completed_goal');
  });

  it('a reply drops the contact (stop on reply) and counts as replied', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m2', ctx.templates.offer)] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    await postWebhook(inboundPayload(PHONE_ID, { id: 'wamid.r1', from: '919811112222', text: 'Interested!' })).expect(200);
    expect(await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id })).toMatchObject({ status: 'dropped', outcome: 'dropped_replied' });
    const funnel = await api().get(`${ctx.seqs}/${id}/funnel`).set(auth(ctx.owner)).expect(200);
    expect(funnel.body.steps[0]).toMatchObject({ sent: 1, replied: 1 });
  });

  it('editing a live sequence only changes the path of new joiners', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.welcome, [nameVar]), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m2', ctx.templates.offer)] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    // v2 replaces the last message with the reminder.
    await api()
      .patch(`${ctx.seqs}/${id}`)
      .set(auth(ctx.owner))
      .send({ draftGraph: { steps: [msg('m1', ctx.templates.welcome, [nameVar]), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m3', ctx.templates.reminder, [{ source: 'text', value: 'Monday', fallback: '' }])] } })
      .expect(200);
    await api().post(`${ctx.seqs}/${id}/publish`).set(auth(ctx.owner)).expect(200);
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811113333'] }).expect(200);
    await advance();
    const byPhone = (p: string) => fake.sent.filter((s) => s.message.to === p).map((s) => (s.message.type === 'template' ? s.message.template.name : ''));
    expect(byPhone('+919811112222')).toEqual(['welcome', 'offer']);
    expect(byPhone('+919811113333')).toEqual(['welcome', 'reminder']);
  });

  it('a late joiner of a webinar only gets future reminders', async () => {
    const ctx = await setup();
    const event = new Date(Date.now() + 2 * 86_400_000); // in two days
    const id = await createSequence(ctx, {
      trigger: { type: 'manual' },
      dateMode: 'fixed',
      fixedDate: event.toISOString(),
      rules: { ...OPEN_RULES, stopOnReply: false },
      draftGraph: {
        steps: [
          msg('m0', ctx.templates.welcome, [nameVar]),
          { id: 'd1', type: 'wait_until_date', offsetDays: -7, time: '10:00' },
          msg('m1', ctx.templates.offer),
          { id: 'd2', type: 'wait_until_date', offsetDays: 1, time: '11:00' },
          msg('m2', ctx.templates.offer),
        ],
      },
    });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    expect(sentTexts()).toEqual(['welcome']);
    const e = await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id });
    expect(e!.currentStepId).toBe('m2');
    const events = await SequenceEvent.find({ workspaceId: ctx.ws.id, enrollmentId: e!._id }).sort({ createdAt: 1, _id: 1 });
    expect(events.filter((x) => x.result === 'skipped').map((x) => `${x.stepId}:${x.reason}`)).toEqual(['d1:Dated reminder already passed', 'm1:Dated reminder already passed']);
    expect(e!.nextRunAt!.getTime()).toBeGreaterThan(event.getTime());
  });

  it('a missing variable without fallback ends the contact with an error', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.welcome, [{ source: 'data', value: 'plan', fallback: '' }])] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    expect(fake.sent).toHaveLength(0);
    expect(await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id })).toMatchObject({ status: 'error', exitReason: 'Variable data "plan" is empty and has no fallback' });
  });

  it('pause keeps people in place; archive exits them; restore comes back paused', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [{ id: 'w1', type: 'wait', amount: 1, unit: 'hours' }, msg('m1', ctx.templates.offer)] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    await api().post(`${ctx.seqs}/${id}/pause`).set(auth(ctx.owner)).expect(200);
    await advance();
    expect(fake.sent).toHaveLength(0);
    await api().post(`${ctx.seqs}/${id}/resume`).set(auth(ctx.owner)).expect(200);
    await advance();
    expect(fake.sent).toHaveLength(1);

    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811113333'] }).expect(200);
    const archived = await api().post(`${ctx.seqs}/${id}/archive`).set(auth(ctx.owner)).expect(200);
    expect(archived.body.exited).toBe(1);
    const restored = await api().post(`${ctx.seqs}/${id}/restore`).set(auth(ctx.owner)).expect(200);
    expect(restored.body.sequence.status).toBe('paused');
  });

  it('test mode runs the draft to your number with 20 s waits and is not counted', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 3, unit: 'days' }, msg('m2', ctx.templates.offer)] } }, false);
    const run = await api().post(`${ctx.seqs}/${id}/test`).set(auth(ctx.owner)).send({ phone: '+919899999999' }).expect(201);
    const e = await SequenceEnrollment.findOne({ _id: run.body.enrollmentId, workspaceId: ctx.ws.id });
    expect(e).toMatchObject({ test: true, currentStepId: 'm2' });
    const wait = e!.nextRunAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(15_000);
    expect(wait).toBeLessThanOrEqual(20_000);
    await advance();
    expect(fake.sent).toHaveLength(2);
    const list = await api().get(ctx.seqs).set(auth(ctx.owner)).expect(200);
    expect(list.body.sequences[0].counts.completed).toBe(0);
    expect(list.body.usage.used).toBe(0);
  });

  it('new contacts from WhatsApp join a welcome sequence; free text inside the 24 h window', async () => {
    const ctx = await setup();
    await createSequence(ctx, { trigger: { type: 'new_contact', sources: ['whatsapp_inbound'] }, draftGraph: { steps: [msg('m1', ctx.templates.welcome, [nameVar], { freeIfWindowOpen: true })] } });
    await postWebhook(inboundPayload(PHONE_ID, { id: 'wamid.new', from: '919822223333', text: 'Hello', name: 'Asha' })).expect(200);
    expect(sentTexts()).toEqual(['text:Hi Asha, welcome to our clinic!']);
  });

  it('date field: appointment reminders the day before and on the day', async () => {
    const ctx = await setup();
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const id = await createSequence(ctx, {
      trigger: { type: 'date_field', fieldKey: 'appointment', direction: 'before', offsetDays: 1, time: '00:00' },
      dateMode: 'per_contact',
      dateKey: 'appointment',
      rules: { ...OPEN_RULES, stopOnReply: false, joinOnce: false, reentryDays: 0 },
      draftGraph: { steps: [msg('m1', ctx.templates.reminder, [{ source: 'data', value: 'appointment', fallback: '' }]), { id: 'd1', type: 'wait_until_date', offsetDays: 0, time: '08:00' }, msg('m2', ctx.templates.offer)] },
    });
    await ctx.contact('+919811112222', { customFields: { appointment: tomorrow } });
    await ctx.contact('+919811113333', { customFields: { appointment: '2020-01-01' } });
    expect(await runDailyTriggers()).toBe(1);
    expect(await runDailyTriggers()).toBe(0); // once a day
    expect(fake.sent[0]!.message.type === 'template' && fake.sent[0]!.message.template.bodyParams).toEqual([tomorrow]);
    const e = await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id, sequenceId: id });
    expect(e!.nextRunAt!.toISOString()).toBe(new Date(`${tomorrow}T08:00:00+05:30`).toISOString());
  });

  it('WhatsApp ecosystem limit (131049): one retry later', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, { trigger: { type: 'manual' }, draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'days' }, msg('m2', ctx.templates.offer)] } });
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones: ['+919811112222'] }).expect(200);
    const sm = await SequenceMessage.findOne({ workspaceId: ctx.ws.id });
    const m = await Message.findOne({ _id: sm!.messageId, workspaceId: ctx.ws.id });
    await postWebhook(statusPayload(PHONE_ID, m!.providerMessageId!, 'failed', Math.floor(Date.now() / 1000), { code: 131049, title: 'Ecosystem limit' })).expect(200);
    expect((await SequenceEvent.findOne({ workspaceId: ctx.ws.id, result: 'retry_scheduled' }))).not.toBeNull();
    await retrySequenceMessage({ workspaceId: ctx.ws.id, sequenceMessageId: String(sm!._id) });
    await retrySequenceMessage({ workspaceId: ctx.ws.id, sequenceMessageId: String(sm!._id) });
    expect(fake.sent).toHaveLength(2);
    expect((await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id }))!.currentStepId).toBe('m2');
  });

  it('many enrollments with mixed waits: every message once, none missed', async () => {
    const ctx = await setup();
    const id = await createSequence(ctx, {
      trigger: { type: 'manual' },
      draftGraph: { steps: [msg('m1', ctx.templates.offer), { id: 'w1', type: 'wait', amount: 1, unit: 'hours' }, msg('m2', ctx.templates.offer), { id: 'w2', type: 'wait', amount: 3, unit: 'days' }, msg('m3', ctx.templates.offer)] },
    });
    const phones = Array.from({ length: 150 }, (_, i) => `+9198${String(10_000_000 + i).padStart(8, '0')}`);
    await api().post(`${ctx.seqs}/${id}/enroll`).set(auth(ctx.owner)).send({ phones }).expect(200);
    // Two schedulers racing, plus duplicate run jobs: still one send per step.
    await SequenceEnrollment.updateMany({ workspaceId: ctx.ws.id }, { nextRunAt: new Date(Date.now() - 1000) });
    const ids = (await SequenceEnrollment.find({ workspaceId: ctx.ws.id }).select('_id').lean()).map((r) => String(r._id));
    await Promise.all([tickSequences(), tickSequences(), ...ids.slice(0, 30).map((enrollmentId) => processSequenceRun({ workspaceId: ctx.ws.id, enrollmentId }))]);
    await advance();
    await advance();
    expect(fake.sent).toHaveLength(450);
    const perPhone = new Map<string, number>();
    for (const s of fake.sent) perPhone.set(s.message.to, (perPhone.get(s.message.to) ?? 0) + 1);
    expect([...perPhone.values()].every((n) => n === 3)).toBe(true);
    expect(await SequenceEnrollment.countDocuments({ workspaceId: ctx.ws.id, status: 'completed' })).toBe(150);
    expect(await Sequence.countDocuments({ workspaceId: ctx.ws.id })).toBe(1);
  });

  it('public API: enroll with data, events move dated reminders and reach goals', async () => {
    const ctx = await setup();
    const key = (await api().post(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).send({ name: 'CRM', scopes: ['sequences:run'] }).expect(201)).body.key as string;
    const h = { 'X-API-Key': key };
    const upgraded = await ctx.tag('upgraded');
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const id = await createSequence(ctx, {
      trigger: { type: 'manual' },
      dateMode: 'per_contact',
      dateKey: 'trial_ends_at',
      goal: { type: 'tag_added', tagIds: [upgraded] },
      draftGraph: {
        steps: [
          msg('m1', ctx.templates.welcome, [{ source: 'data', value: 'plan', fallback: '' }]),
          { id: 'd1', type: 'wait_until_date', offsetDays: -1, time: '10:00' },
          msg('m2', ctx.templates.offer),
        ],
      },
    });
    const res = await api()
      .post(`/api/v1/sequences/${id}/enroll`)
      .set(h)
      .send({ contacts: [{ phone: '+919876543210', name: 'Ravi', data: { trial_ends_at: day(10), plan: 'Pro' } }, { phone: '12345', data: {} }] })
      .expect(200);
    expect(res.body.data.map((r: { result: string }) => r.result)).toEqual(['enrolled', 'invalid']);
    expect(fake.sent[0]!.message.type === 'template' && fake.sent[0]!.message.template.bodyParams).toEqual(['Pro']);
    const before = (await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id }))!.nextRunAt!;
    expect(before.toISOString()).toBe(new Date(`${day(9)}T10:00:00+05:30`).toISOString());

    // New trial end date: the reminder moves.
    await api().post('/api/v1/sequences/events').set(h).send({ phone: '+919876543210', event: 'trial_extended', data: { trial_ends_at: day(20) } }).expect(200);
    const moved = await SequenceEnrollment.findOne({ workspaceId: ctx.ws.id });
    expect(moved!.nextRunAt!.toISOString()).toBe(new Date(`${day(19)}T10:00:00+05:30`).toISOString());

    // "upgraded" event = goal tag: done.
    await api().post('/api/v1/sequences/events').set(h).send({ phone: '+919876543210', event: 'upgraded' }).expect(200);
    const status = await api().get(`/api/v1/sequences/${id}/contacts/+919876543210`).set(h).expect(200);
    expect(status.body.data).toMatchObject({ status: 'completed', outcome: 'completed_goal' });
    expect(status.body.data.history.map((x: { result: string }) => x.result)).toContain('replanned');

    await api().post(`/api/v1/sequences/${id}/enroll`).set(h).send({ contacts: [{ phone: '+919811110000', data: { plan: 'Basic', trial_ends_at: day(10) } }] }).expect(200);
    const exit = await api().post(`/api/v1/sequences/${id}/exit`).set(h).send({ phone: '+919811110000', reason: 'order_cancelled' }).expect(200);
    expect(exit.body.data.exited).toBe(true);
  });
});
