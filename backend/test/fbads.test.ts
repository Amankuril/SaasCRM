import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { setAdsTransport, type Transport } from '../src/modules/fbads/fbads.graph.js';
import { FbApiLog, FbConnection, FbEntity } from '../src/modules/fbads/fbads.model.js';
import { resetAdsSandbox, sandboxObject, sandboxTransport } from '../src/modules/fbads/fbads.sandbox.js';
import { hashContact, runSync, signState } from '../src/modules/fbads/fbads.service.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

beforeEach(() => {
  resetAdsSandbox();
  setAdsTransport(sandboxTransport);
});
afterEach(() => setAdsTransport(null));

async function connected(pick = 'act_1001') {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}/facebook-ads`;
  const cb = await api().get(`/api/facebook-ads/oauth/callback?code=abc&state=${encodeURIComponent(signState(ws.id, owner.id))}`).expect(302);
  expect(cb.headers.location).toContain(`/w/${ws.id}/facebook/ads?fb=choose`);
  if (pick) await api().post(`${base}/account`).set(auth(owner)).send({ adAccountId: pick }).expect(200);
  return { owner, ws, base };
}

describe('Facebook Ads', () => {
  it('connects, picks an account, syncs and counts from the local copy; token encrypted', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}/facebook-ads`;
    expect((await api().get(base).set(auth(owner)).expect(200)).body.connection).toBeNull();
    await api().get(`/api/facebook-ads/oauth/callback?code=abc&state=bad.sig`).expect(302);
    await api().get(`/api/facebook-ads/oauth/callback?code=abc&state=${encodeURIComponent(signState(ws.id, owner.id))}`).expect(302);

    const pending = await api().get(base).set(auth(owner)).expect(200);
    expect(pending.body.connection).toMatchObject({ status: 'pending', fbUserName: 'Sandbox Owner', adAccountId: null });
    const accounts = await api().get(`${base}/accounts`).set(auth(owner)).expect(200);
    expect(accounts.body.accounts.map((a: { id: string }) => a.id)).toEqual(['act_1001', 'act_1002']);
    await api().post(`${base}/account`).set(auth(owner)).send({ adAccountId: 'act_9999' }).expect(400);
    await api().post(`${base}/account`).set(auth(owner)).send({ adAccountId: 'act_1001' }).expect(200);

    const home = await api().get(base).set(auth(owner)).expect(200);
    expect(home.body.connection).toMatchObject({ status: 'connected', adAccountName: 'Dr Patidar Clinic Ads', currency: 'INR', timezone: 'Asia/Kolkata', accountStatus: 1, sync: { status: 'idle' } });
    expect(home.body.counts).toEqual({ campaigns: 2, activeCampaigns: 1, adsets: 2, ads: 2, rejectedAds: 1 });

    const stored = await FbConnection.findOne({ workspaceId: ws.id }).select('+accessTokenEnc').lean();
    expect(stored!.accessTokenEnc).toMatch(/^v1:/);
    expect(stored!.accessTokenEnc).not.toContain('sandbox-token');
    expect(JSON.stringify(home.body)).not.toContain('sandbox-token');

    const adsets = await api().get(`${base}/entities/adset`).set(auth(owner)).expect(200);
    expect(adsets.body.rows.find((r: { name: string }) => r.name === 'Indore 25-55')).toMatchObject({ targetingSummary: 'Indore, IN · 25-55', campaign: { name: 'Dental check-up leads' } });
    const ads = await api().get(`${base}/entities/ad?status=rejected`).set(auth(owner)).expect(200);
    expect(ads.body.rows).toEqual([expect.objectContaining({ name: 'Braces ad', reviewStatus: 'Rejected', creative: expect.objectContaining({ name: 'Braces video' }) })]);

    const logs = await api().get(`${base}/logs`).set(auth(owner)).expect(200);
    expect(logs.body.logs.some((l: { endpoint: string }) => l.endpoint === '/act_1001/campaigns')).toBe(true);
    await api().post(`${base}/verify`).set(auth(owner)).expect(200);
  });

  it('creates a paused campaign on Meta and locally; shows Meta errors in plain words', async () => {
    const { owner, ws, base } = await connected();
    const created = await api().post(`${base}/campaigns`).set(auth(owner)).send({ name: 'Diwali offer', objective: 'OUTCOME_LEADS', budgetMode: 'daily', budget: 500 }).expect(201);
    expect(sandboxObject(created.body.id)).toMatchObject({ name: 'Diwali offer', status: 'PAUSED', daily_budget: '50000', special_ad_categories: [] });
    const local = await FbEntity.findOne({ workspaceId: ws.id, kind: 'campaign', metaId: created.body.id });
    expect(local).toMatchObject({ status: 'PAUSED', dailyBudget: 50000, objective: 'OUTCOME_LEADS' });

    const low = await api().post(`${base}/campaigns`).set(auth(owner)).send({ name: 'Tiny', objective: 'OUTCOME_TRAFFIC', budgetMode: 'daily', budget: 10 }).expect(422);
    expect(low.body.error.message).toContain('minimum daily budget');

    const later = await api().post(`${base}/campaigns`).set(auth(owner)).send({ name: 'Budget on ad sets', objective: 'OUTCOME_TRAFFIC', budgetMode: 'later' }).expect(201);
    expect(sandboxObject(later.body.id)).toMatchObject({ is_adset_budget_sharing_enabled: false });
  });

  it('builds a Click-to-WhatsApp ad: ad set, image, creative, ad', async () => {
    const { owner, base } = await connected();
    const campaign = (await api().post(`${base}/campaigns`).set(auth(owner)).send({ name: 'CTWA', objective: 'OUTCOME_ENGAGEMENT', budgetMode: 'later' }).expect(201)).body.id;
    const noBudget = await api()
      .post(`${base}/adsets`)
      .set(auth(owner))
      .send({ campaignId: campaign, name: 'Indore', locations: [{ type: 'city', key: '1035921', name: 'Indore' }], optimizationGoal: 'CONVERSATIONS' })
      .expect(400);
    expect(noBudget.body.error.details.budget).toBeDefined();
    const adset = (
      await api()
        .post(`${base}/adsets`)
        .set(auth(owner))
        .send({ campaignId: campaign, name: 'Indore', budgetMode: 'daily', budget: 300, locations: [{ type: 'city', key: '1035921', name: 'Indore' }], ageMin: 25, ageMax: 50, gender: 'female', interests: [{ id: '6001', name: 'Oral hygiene' }], optimizationGoal: 'CONVERSATIONS' })
        .expect(201)
    ).body.id;
    expect(sandboxObject(adset)!.targeting).toMatchObject({ geo_locations: { cities: [{ key: '1035921' }] }, age_min: 25, genders: [2], flexible_spec: [{ interests: [{ id: '6001', name: 'Oral hygiene' }] }] });

    const image = await api().post(`${base}/media`).set(auth(owner)).set('Content-Type', 'image/png').set('X-File-Name', 'smile.png').send(Buffer.from('fake-png')).expect(201);
    expect(image.body).toMatchObject({ type: 'image', hash: expect.any(String) });
    const pages = await api().get(`${base}/pages`).set(auth(owner)).expect(200);
    const creative = (
      await api()
        .post(`${base}/creatives`)
        .set(auth(owner))
        .send({ name: 'Smile CTWA', pageId: pages.body.pages[0].id, media: { type: 'image', hash: image.body.hash }, primaryText: 'Chat with us on WhatsApp', headline: 'Free check-up', destination: 'whatsapp' })
        .expect(201)
    ).body.id;
    expect((sandboxObject(creative)!.object_story_spec as { link_data: { call_to_action: unknown } }).link_data.call_to_action).toEqual({ type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } });
    const ad = await api().post(`${base}/ads`).set(auth(owner)).send({ name: 'CTWA ad', adsetId: adset, creativeId: creative }).expect(201);
    const list = await api().get(`${base}/entities/ad?q=CTWA`).set(auth(owner)).expect(200);
    expect(list.body.rows[0]).toMatchObject({ id: ad.body.id, reviewStatus: 'In review', adset: { name: 'Indore' }, creative: { name: 'Smile CTWA' } });

    const interests = await api().get(`${base}/search/interests?q=dent`).set(auth(owner)).expect(200);
    expect(interests.body.results.map((r: { name: string }) => r.name)).toContain('Dentistry');
  });

  it('row actions: pause/activate, duplicate, delete; sync marks missing rows deleted', async () => {
    const { owner, ws, base } = await connected();
    const rows = (await api().get(`${base}/entities/campaign`).set(auth(owner)).expect(200)).body.rows;
    const active = rows.find((r: { name: string }) => r.name === 'Dental check-up leads');
    await api().post(`${base}/entities/campaign/${active.id}/status`).set(auth(owner)).send({ status: 'PAUSED' }).expect(200);
    expect(sandboxObject(active.id)!.status).toBe('PAUSED');
    expect((await api().get(base).set(auth(owner))).body.counts.activeCampaigns).toBe(0);
    await api().patch(`${base}/entities/campaign/${active.id}`).set(auth(owner)).send({ name: 'Dental leads', dailyBudget: 700 }).expect(200);
    expect(sandboxObject(active.id)).toMatchObject({ name: 'Dental leads', daily_budget: '70000' });

    const copy = await api().post(`${base}/entities/campaign/${active.id}/duplicate`).set(auth(owner)).expect(201);
    expect(await FbEntity.exists({ workspaceId: ws.id, kind: 'campaign', metaId: copy.body.id, deletedAt: null })).toBeTruthy();
    await api().delete(`${base}/entities/campaign/${copy.body.id}`).set(auth(owner)).expect(204);
    expect((await api().get(`${base}/entities/campaign?status=deleted`).set(auth(owner))).body.rows.map((r: { id: string }) => r.id)).toContain(copy.body.id);

    // Deleted directly on Meta: the next sync marks it deleted here too.
    sandboxObject(rows[1].id)!.status = 'DELETED';
    await runSync(new Types.ObjectId(ws.id));
    expect(await FbEntity.findOne({ workspaceId: ws.id, metaId: rows[1].id })).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('an expired token turns the connection into "reconnect" and blocks writes', async () => {
    const { owner, base } = await connected();
    const real = sandboxTransport;
    setAdsTransport((_t, req) => real('sandbox-expired', req));
    const res = await api().post(`${base}/campaigns`).set(auth(owner)).send({ name: 'X', objective: 'OUTCOME_TRAFFIC', budgetMode: 'later' }).expect(409);
    expect(res.body.error.code).toBe('FB_RECONNECT');
    expect((await api().get(base).set(auth(owner))).body.connection.status).toBe('error');
    setAdsTransport(real);
    expect((await api().post(`${base}/sync`).set(auth(owner)).expect(409)).body.error.code).toBe('FB_RECONNECT');
    // Reconnecting fixes it.
    await api().get(`/api/facebook-ads/oauth/callback?code=new&state=${encodeURIComponent(signState(base.split('/')[3]!, owner.id))}`).expect(302);
    expect((await api().get(base).set(auth(owner))).body.connection.status).toBe('connected');
  });

  it('pages through big accounts and backs off when Meta reports > 80% usage', async () => {
    const { owner, ws, base } = await connected();
    for (let i = 0; i < 120; i++) await sandboxTransport('t', { method: 'POST', path: '/act_1001/campaigns', params: { name: `C${i}`, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', daily_budget: '10000' } });
    await runSync(new Types.ObjectId(ws.id));
    expect((await api().get(base).set(auth(owner))).body.counts.campaigns).toBe(122);

    const busy: Transport = async (t, req) => ({ ...(await sandboxTransport(t, req)), headers: { 'x-business-use-case-usage': JSON.stringify({ '1001': [{ call_count: 91, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 2 }] }) } });
    setAdsTransport(busy);
    await runSync(new Types.ObjectId(ws.id));
    const conn = await FbConnection.findOne({ workspaceId: ws.id });
    expect(conn!.sync).toMatchObject({ status: 'queued', error: 'Waiting: Facebook rate limit' });
    expect(await FbEntity.countDocuments({ workspaceId: ws.id, kind: 'campaign', deletedAt: null })).toBe(122);
    expect(await FbApiLog.countDocuments({ workspaceId: ws.id })).toBeGreaterThan(5);
  });

  it('custom audiences upload only SHA-256 hashes of contacts', async () => {
    const { owner, ws, base } = await connected();
    await Contact.create([
      { workspaceId: ws.id, phoneE164: '+919811112222', email: ' Ravi@Example.com ' },
      { workspaceId: ws.id, phoneE164: '+919811113333' },
      { workspaceId: ws.id, phoneE164: '+919811114444', consent: { status: 'opted_out' } },
    ]);
    expect(hashContact('+919811112222', ' Ravi@Example.com ')).toEqual([createHash('sha256').update('919811112222').digest('hex'), createHash('sha256').update('ravi@example.com').digest('hex')]);
    const sent: unknown[] = [];
    setAdsTransport(async (t, req) => {
      if (req.path.endsWith('/users')) sent.push(req.params);
      return sandboxTransport(t, req);
    });
    const res = await api().post(`${base}/audiences`).set(auth(owner)).send({ subtype: 'custom', name: 'Patients' }).expect(201);
    expect(res.body.uploaded).toBe(2);
    expect(JSON.stringify(sent)).not.toContain('9811112222"');
    expect(JSON.stringify(sent)).not.toContain('ravi@');
    const look = await api().post(`${base}/audiences`).set(auth(owner)).send({ subtype: 'lookalike', name: 'Like patients 1%', sourceAudienceId: res.body.id, country: 'in', percent: 1 }).expect(201);
    expect(look.body.id).toBeTruthy();
    const pixel = await api().post(`${base}/pixels`).set(auth(owner)).send({ name: 'Website' }).expect(201);
    const detail = await api().get(`${base}/pixels/${pixel.body.id}`).set(auth(owner)).expect(200);
    expect(detail.body.code).toContain(`fbq('init', '${pixel.body.id}')`);
  });

  it('keeps workspaces apart and lets only owners/admins change ads', async () => {
    const a = await connected();
    const b = await connected('');
    const bList = await api().get(`${b.base}/entities/campaign`).set(auth(b.owner)).expect(200);
    expect(bList.body.rows).toEqual([]);
    const aRow = (await api().get(`${a.base}/entities/campaign`).set(auth(a.owner))).body.rows[0];
    await api().post(`${b.base}/entities/campaign/${aRow.id}/status`).set(auth(b.owner)).send({ status: 'PAUSED' }).expect(409);
    await api().get(a.base).set(auth(b.owner)).expect(404);

    const analyst = await signup({ email: 'analyst@example.com' });
    await addMember(a.owner, a.ws.id, analyst, 'analyst');
    await api().get(`${a.base}/entities/campaign`).set(auth(analyst)).expect(200);
    await api().post(`${a.base}/campaigns`).set(auth(analyst)).send({ name: 'X', objective: 'OUTCOME_TRAFFIC', budgetMode: 'later' }).expect(403);

    await api().post(`${a.base}/disconnect`).set(auth(a.owner)).expect(200);
    expect((await api().get(a.base).set(auth(a.owner))).body.connection).toBeNull();
    expect((await FbConnection.findOne({ workspaceId: a.ws.id }).select('+accessTokenEnc').lean())!.accessTokenEnc).toBeNull();
  });
});
