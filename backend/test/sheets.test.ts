import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { SheetAccessError, decodeState, encodeState, parseCsv, parseSheetUrl, setSheetsClient, type SheetsClient } from '../src/modules/integrations/googleSheets.js';
import { SheetRow } from '../src/modules/integrations/sheets.model.js';
import { pollSheets } from '../src/modules/integrations/sheets.service.js';
import { Message } from '../src/modules/messages/message.model.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, sign, statusPayload } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

/** An in-memory spreadsheet the tests edit "live". */
class FakeSheets implements SheetsClient {
  tabs = [
    { gid: '0', title: 'Leads' },
    { gid: '77', title: 'Archive' },
  ];
  data: Record<string, string[][]> = { '0': [['Name', 'Phone', 'City']], '77': [['x']] };
  shared = true;
  async info() {
    if (!this.shared) throw new SheetAccessError('NOT_SHARED', 'This sheet is not shared.');
    return { title: 'Clinic leads', tabs: this.tabs };
  }
  async rows(_id: string, tab: { gid: string }) {
    if (!this.shared) throw new SheetAccessError('NOT_SHARED', 'This sheet is not shared.');
    return this.data[tab.gid] ?? [];
  }
  add(...rows: string[][]) {
    this.data['0']!.push(...rows);
  }
}

let wa: FakeProvider;
let sheets: FakeSheets;
beforeEach(() => {
  wa = new FakeProvider();
  sheets = new FakeSheets();
  setWhatsAppProvider(wa);
  setSheetsClient(sheets);
});
afterEach(() => {
  setWhatsAppProvider(undefined);
  setSheetsClient(undefined);
});

const TEMPLATE = {
  providerTemplateId: 'tpl-welcome',
  name: 'lead_welcome',
  language: 'en',
  category: 'UTILITY',
  status: 'APPROVED',
  rejectedReason: null,
  components: [{ type: 'BODY' as const, text: 'Hi {{1}}, thanks for your enquiry from {{2}}!' }],
};

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}/integrations/google-sheets`;
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  wa.templates = [TEMPLATE];
  await api().post(`/api/workspaces/${ws.id}/templates/sync`).set(auth(owner)).expect(200);
  const template = await MessageTemplate.findOne({ workspaceId: ws.id, name: 'lead_welcome' });
  return { owner, ws, base, as: auth(owner), templateId: template!.id as string };
}

/** Runs the wizard: link → connect → tab → template mapping → settings. */
async function liveCampaign(ctx: Awaited<ReturnType<typeof setup>>, settings: object = {}) {
  const c = (await api().post(ctx.base).set(ctx.as).send({ sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` }).expect(201)).body.campaign;
  await api().post(`${ctx.base}/${c.id}/connect`).set(ctx.as).send({ access: 'link' }).expect(200);
  await api().post(`${ctx.base}/${c.id}/tab`).set(ctx.as).send({ gid: '0', phoneColumn: 'Phone', nameColumn: 'Name' }).expect(200);
  await api()
    .patch(`${ctx.base}/${c.id}`)
    .set(ctx.as)
    .send({
      templateId: ctx.templateId,
      bodyVariables: [
        { source: 'column', value: 'Name' },
        { source: 'column', value: 'City', fallback: 'our website' },
      ],
      ...settings,
    })
    .expect(200);
  return (await api().post(`${ctx.base}/${c.id}/activate`).set(ctx.as).expect(200)).body;
}

const sentTo = () => wa.sent.map((s) => s.message.to.replace(/^\+/, ''));

describe('google sheets helpers', () => {
  it('parses links, CSV and signed OAuth state', () => {
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=123`)).toEqual({ spreadsheetId: SHEET_ID, gid: '123' });
    expect(parseSheetUrl('https://example.com/sheet')).toBeNull();
    expect(parseCsv('a,"b, c","d ""q"""\r\n1,,3\n')).toEqual([
      ['a', 'b, c', 'd "q"'],
      ['1', '', '3'],
    ]);
    const state = encodeState({ workspaceId: 'w', userId: 'u', campaignId: 'c' });
    expect(decodeState(state)).toMatchObject({ workspaceId: 'w', campaignId: 'c' });
    expect(decodeState(state.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')))).toBeNull();
  });
});

describe('google sheets campaigns', () => {
  it('walks the setup steps, detecting columns and refusing to go live half-done', async () => {
    const ctx = await setup();
    sheets.add(['Asha', '98111 11111', 'Pune']);
    await api().post(ctx.base).set(ctx.as).send({ sheetUrl: 'https://example.com/x' }).expect(400);
    const c = (await api().post(ctx.base).set(ctx.as).send({ sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }).expect(201)).body.campaign;

    sheets.shared = false;
    const blocked = await api().post(`${ctx.base}/${c.id}/connect`).set(ctx.as).send({ access: 'link' }).expect(422);
    expect(blocked.body.error.code).toBe('SHEET_NOT_SHARED');
    sheets.shared = true;
    const connected = (await api().post(`${ctx.base}/${c.id}/connect`).set(ctx.as).send({ access: 'link' }).expect(200)).body;
    expect(connected.tabs.map((t: { title: string }) => t.title)).toEqual(['Leads', 'Archive']);
    expect(connected.campaign).toMatchObject({ name: 'Clinic leads', step: 'select' });
    await api().post(`${ctx.base}/${c.id}/connect`).set(ctx.as).send({ access: 'google' }).expect(400);

    const preview = (await api().get(`${ctx.base}/${c.id}/preview?gid=0`).set(ctx.as).expect(200)).body;
    expect(preview).toMatchObject({ headers: ['Name', 'Phone', 'City'], total: 1, detected: { phoneColumn: 'Phone', nameColumn: 'Name' } });
    await api().post(`${ctx.base}/${c.id}/tab`).set(ctx.as).send({ gid: '0', phoneColumn: 'Mobile' }).expect(400);
    await api().post(`${ctx.base}/${c.id}/tab`).set(ctx.as).send({ gid: '0', phoneColumn: 'Phone' }).expect(200);

    const notReady = await api().post(`${ctx.base}/${c.id}/activate`).set(ctx.as).expect(400);
    expect(Object.keys(notReady.body.error.details)).toContain('templateId');
    await api().patch(`${ctx.base}/${c.id}`).set(ctx.as).send({ templateId: ctx.templateId, bodyVariables: [{ source: 'column', value: 'Nope' }] }).expect(200);
    const badMap = await api().post(`${ctx.base}/${c.id}/activate`).set(ctx.as).expect(400);
    expect(badMap.body.error.details.bodyVariables).toEqual(['Map 2 value(s).']);
  });

  it('skips rows already in the sheet, then messages each new row once as the sheet is edited', async () => {
    const ctx = await setup();
    sheets.add(['Old Lead', '9811111111', 'Pune']);
    const { campaign, sync } = await liveCampaign(ctx);
    expect(sync).toMatchObject({ rows: 1, skipped: 1, sent: 0 });
    expect(campaign.state).toBe('active');

    // Someone adds rows while the campaign is live; one is still being typed.
    sheets.add(['Priya', '+91 98222 22222', 'Mumbai'], ['', '9833333333', ''], ['Bad', '12', 'x'], ['Dup', '9811111111', 'Pune']);
    await pollSheets();
    expect(sentTo()).toEqual(['919822222222']);
    const msg = await Message.findOne({ workspaceId: ctx.ws.id }).lean();
    expect((msg!.content as { bodyParams: string[] }).bodyParams).toEqual(['Priya', 'Mumbai']);
    expect((await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919822222222' }))!.name).toBe('Priya');

    // The half-typed row is finished: it goes out on the next check; nothing is sent twice.
    sheets.data['0']![3] = ['Ravi', '9833333333', ''];
    const res = (await api().post(`${ctx.base}/${campaign.id}/sync`).set(ctx.as).expect(200)).body;
    expect(res.sync).toMatchObject({ sent: 1, invalid: 1 });
    expect(sentTo()).toEqual(['919822222222', '919833333333']);
    const latest = await Message.findOne({ workspaceId: ctx.ws.id }).sort({ _id: -1 }).lean();
    expect(latest!.content).toMatchObject({ bodyParams: ['Ravi', 'our website'] });
    await pollSheets();
    expect(wa.sent).toHaveLength(2);

    // Delivery receipts show up per row.
    const ids = (await Message.find({ workspaceId: ctx.ws.id }).sort({ _id: 1 }).lean()).map((m) => m.providerMessageId!);
    const body = JSON.stringify(statusPayload(PHONE_ID, ids[0]!, 'read', Math.floor(Date.now() / 1000)));
    await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
    const rows = (await api().get(`${ctx.base}/${campaign.id}/rows`).set(ctx.as).expect(200)).body;
    expect(rows.rows.map((r: { phone: string; state: string }) => [r.phone, r.state])).toEqual([
      ['+919811111111', 'skipped'],
      ['+919822222222', 'read'],
      ['+919833333333', 'sent'],
    ]);
    expect(rows.counts).toMatchObject({ read: 1, sent: 1, skipped: 1, messages: 2 });
    expect((await api().get(`${ctx.base}/${campaign.id}/rows?state=read`).set(ctx.as)).body.total).toBe(1);
    expect((await api().get(`${ctx.base}/${campaign.id}/rows?q=98333`).set(ctx.as)).body.total).toBe(1);
    const csv = await api().get(`${ctx.base}/${campaign.id}/rows/export`).set(ctx.as).expect(200);
    expect(csv.text.split('\n')[0]).toBe('Row,Phone,Status,Error,Name,Phone,City');

    const list = (await api().get(ctx.base).set(ctx.as).expect(200)).body;
    expect(list.stats).toEqual({ total: 1, active: 1, paused: 0, messages: 2 });
    expect(list.google.configured).toBe(false);
  });

  it('sends existing rows when asked, waits for the send delay, pauses and reports sheet errors', async () => {
    const ctx = await setup();
    sheets.add(['Asha', '9811111111', 'Pune']);
    const { campaign, sync } = await liveCampaign(ctx, { startFrom: 'all' });
    expect(sync.sent).toBe(1);

    await api().post(`${ctx.base}/${campaign.id}/pause`).set(ctx.as).expect(200);
    sheets.add(['Priya', '9822222222', 'Mumbai']);
    await pollSheets(); // paused campaigns are not checked
    expect(wa.sent).toHaveLength(1);

    await api().patch(`${ctx.base}/${campaign.id}`).set(ctx.as).send({ sendDelayMinutes: 30 }).expect(200);
    const resumed = (await api().post(`${ctx.base}/${campaign.id}/activate`).set(ctx.as).expect(200)).body;
    expect(resumed.sync).toMatchObject({ added: 1, sent: 0 });
    expect((await api().get(`${ctx.base}/${campaign.id}/rows?state=queued`).set(ctx.as)).body.total).toBe(1);
    await pollSheets(); // due in 30 minutes
    expect(wa.sent).toHaveLength(1);
    // Once due, it goes out.
    await SheetRow.updateMany({ workspaceId: ctx.ws.id }, { dueAt: new Date(Date.now() - 1000) });
    await pollSheets();
    expect(sentTo()).toEqual(['919811111111', '919822222222']);

    sheets.shared = false;
    const broken = (await api().post(`${ctx.base}/${campaign.id}/sync`).set(ctx.as).expect(200)).body.campaign;
    expect(broken).toMatchObject({ state: 'error', lastError: 'This sheet is not shared.' });

    // A different tab can't be swapped in once rows were recorded.
    await api().patch(`${ctx.base}/${campaign.id}`).set(ctx.as).send({ tabGid: '77' }).expect(409);
    await api().delete(`${ctx.base}/${campaign.id}`).set(ctx.as).expect(204);
    expect((await api().get(ctx.base).set(ctx.as)).body.campaigns).toHaveLength(0);
  });

  it('keeps Google sign-in off when no OAuth client is configured', async () => {
    const ctx = await setup();
    const res = await api().get(`${ctx.base}/google/auth-url?campaignId=64b000000000000000000000`).set(ctx.as).expect(409);
    expect(res.body.error.code).toBe('GOOGLE_NOT_CONFIGURED');
    const cb = await api().get('/api/integrations/google/callback?state=forged&code=x').expect(302);
    expect(cb.headers.location).toMatch(/google=expired$/);
  });
});
