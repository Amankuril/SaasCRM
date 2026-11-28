import { randomBytes } from 'node:crypto';
import type { GraphRequest, GraphResponse, Transport } from './fbads.graph.js';

/**
 * In-memory stand-in for the Marketing API (ADS_PROVIDER=sandbox): two ad
 * accounts with sample campaigns, ad sets, ads (one rejected), creatives, an
 * audience and a pixel. Only the endpoints Zeta Connect calls are emulated.
 */

type Obj = Record<string, unknown> & { id: string };
interface Account {
  info: Obj;
  edges: Record<string, Obj[]>;
}

const EDGES = ['campaigns', 'adsets', 'ads', 'adcreatives', 'customaudiences', 'adspixels'] as const;
const accounts = new Map<string, Account>();
const byId = new Map<string, { account: string; edge: string; obj: Obj }>();
let counter = 0;
const newId = () => `${Date.now()}${String(++counter).padStart(4, '0')}`;
const now = () => new Date().toISOString();

/** Tests: start from a clean, freshly seeded sandbox. */
export function resetAdsSandbox(): void {
  accounts.clear();
  byId.clear();
}

/** Tests: the sandbox's own copy of an object (as Meta would have it). */
export function sandboxObject(id: string): Obj | undefined {
  return byId.get(id)?.obj;
}

function add(account: string, edge: string, obj: Omit<Obj, 'id'> & { id?: string }): Obj {
  const full = { ...obj, id: obj.id ?? newId() } as Obj;
  accounts.get(account)!.edges[edge]!.push(full);
  byId.set(full.id, { account, edge, obj: full });
  return full;
}

function seed(account: string, name: string) {
  accounts.set(account, {
    info: { id: account, account_id: account.slice(4), name, currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1 },
    edges: Object.fromEntries(EDGES.map((e) => [e, []])),
  });
  if (account !== 'act_1001') return;
  const c1 = add(account, 'campaigns', { name: 'Dental check-up leads', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000', special_ad_categories: [], updated_time: now() });
  const c2 = add(account, 'campaigns', { name: 'Clinic awareness', objective: 'OUTCOME_AWARENESS', buying_type: 'AUCTION', status: 'PAUSED', effective_status: 'PAUSED', special_ad_categories: [], updated_time: now() });
  const s1 = add(account, 'adsets', {
    name: 'Indore 25-55',
    campaign_id: c1.id,
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    optimization_goal: 'LEAD_GENERATION',
    billing_event: 'IMPRESSIONS',
    targeting: { geo_locations: { countries: ['IN'], cities: [{ key: '1035921', name: 'Indore' }] }, age_min: 25, age_max: 55 },
    updated_time: now(),
  });
  const s2 = add(account, 'adsets', { name: 'Lookalike 1%', campaign_id: c2.id, status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', daily_budget: '30000', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['IN'] }, age_min: 18, age_max: 65 }, updated_time: now() });
  const cr1 = add(account, 'adcreatives', { name: 'Smile offer', object_type: 'SHARE', thumbnail_url: 'https://placehold.co/120x120/png?text=Smile', title: 'Free dental check-up', body: 'Book your visit this week.', call_to_action_type: 'WHATSAPP_MESSAGE' });
  const cr2 = add(account, 'adcreatives', { name: 'Braces video', object_type: 'VIDEO', thumbnail_url: 'https://placehold.co/120x120/png?text=Video', title: 'Straight teeth in months', call_to_action_type: 'LEARN_MORE' });
  add(account, 'ads', { name: 'Check-up WhatsApp ad', adset_id: s1.id, campaign_id: c1.id, creative: { id: cr1.id }, status: 'ACTIVE', effective_status: 'ACTIVE', updated_time: now() });
  add(account, 'ads', { name: 'Braces ad', adset_id: s2.id, campaign_id: c2.id, creative: { id: cr2.id }, status: 'ACTIVE', effective_status: 'DISAPPROVED', ad_review_feedback: { global: { 'Before and after': 'Ads may not show before-and-after images.' } }, updated_time: now() });
  add(account, 'customaudiences', { name: 'Existing patients', subtype: 'CUSTOM', approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1500, time_updated: Math.floor(Date.now() / 1000) });
  add(account, 'adspixels', { name: 'Clinic website pixel', last_fired_time: now() });
}

function ensure(account: string): Account | null {
  if (!/^act_\d+$/.test(account)) return null;
  if (!accounts.has(account)) {
    if (account === 'act_1001') seed(account, 'Dr Patidar Clinic Ads');
    else if (account === 'act_1002') seed(account, 'Second ad account');
    else return null;
  }
  return accounts.get(account)!;
}

const ok = (body: unknown, status = 200): GraphResponse => ({ status, headers: { 'x-business-use-case-usage': JSON.stringify({ sandbox: [{ call_count: 3, total_cputime: 2, total_time: 2 }] }) }, body });
const fail = (message: string, code = 100, status = 400): GraphResponse => ({ status, headers: {}, body: { error: { message, code, type: 'OAuthException' } } });

export const sandboxTransport: Transport = async (token, req: GraphRequest) => {
  const p = req.params ?? {};
  const parts = req.path.split('/').filter(Boolean);

  if (req.path === '/oauth/access_token') return ok({ access_token: `sandbox-token-${randomBytes(4).toString('hex')}`, token_type: 'bearer', expires_in: 60 * 86_400 });
  if (!token) return fail('An access token is required.', 104, 401);
  if (token === 'sandbox-expired') return fail('Error validating access token: Session has expired.', 190, 401);

  if (req.path === '/me') return ok({ id: '10001', name: 'Sandbox Owner' });
  if (req.path === '/me/adaccounts') {
    ensure('act_1001');
    ensure('act_1002');
    return ok({ data: [...accounts.values()].map((a) => a.info) });
  }
  if (req.path === '/me/accounts') return ok({ data: [{ id: '2001', name: 'Dr Patidar Clinic' }, { id: '2002', name: 'Clinic Offers' }] });
  if (req.path === '/search' && p.type === 'adinterest') {
    const all = ['Dentistry', 'Oral hygiene', 'Health & wellness', 'Cosmetic dentistry', 'Orthodontics', 'Fitness', 'Parenting'];
    const q = String(p.q ?? '').toLowerCase();
    return ok({ data: all.filter((n) => n.toLowerCase().includes(q)).map((name, i) => ({ id: `600${i}`, name, audience_size_lower_bound: 1_000_000 * (i + 1) })) });
  }

  if (req.path === '/search' && p.type === 'adgeolocation') {
    const all = [
      { key: 'IN', name: 'India', type: 'country', country_code: 'IN' },
      { key: '1035921', name: 'Indore', type: 'city', region: 'Madhya Pradesh', country_code: 'IN' },
      { key: '1025', name: 'Madhya Pradesh', type: 'region', country_code: 'IN' },
      { key: '1035948', name: 'Bhopal', type: 'city', region: 'Madhya Pradesh', country_code: 'IN' },
      { key: 'AE', name: 'United Arab Emirates', type: 'country', country_code: 'AE' },
    ];
    const q = String(p.q ?? '').toLowerCase();
    return ok({ data: all.filter((l) => l.name.toLowerCase().includes(q)) });
  }

  // /act_X and /act_X/<edge>
  if (parts[0]?.startsWith('act_')) {
    const account = ensure(parts[0]);
    if (!account) return fail('Unsupported get request. Object does not exist or you do not have permission.', 100);
    if (parts.length === 1) return ok(account.info);
    const edge = parts[1]!;
    if (req.method === 'GET' && (EDGES as readonly string[]).includes(edge)) {
      const rows = account.edges[edge]!.filter((o) => o.status !== 'DELETED');
      const limit = Number(p.limit ?? 25);
      const start = p.after ? Number(Buffer.from(String(p.after), 'base64').toString()) : 0;
      const page = rows.slice(start, start + limit);
      const next = start + limit < rows.length ? Buffer.from(String(start + limit)).toString('base64') : null;
      return ok({ data: page, paging: { cursors: { after: next ?? '' }, ...(next ? { next: 'sandbox://next' } : {}) } });
    }
    if (req.method === 'POST') {
      if (edge === 'adimages') return ok({ images: { upload: { hash: randomBytes(16).toString('hex'), url: 'https://placehold.co/600x600/png?text=Image' } } });
      if (edge === 'advideos') return ok({ id: newId() });
      if (edge === 'campaigns') {
        if (!p.name || !p.objective) return fail('Name and objective are required.');
        if (Number(p.daily_budget ?? Infinity) < 8900) return fail('Your budget is too low. The minimum daily budget for this account is ₹89.00.', 100);
        const o = add(parts[0], 'campaigns', { ...p, effective_status: p.status, updated_time: now() });
        return ok({ id: o.id });
      }
      if (edge === 'adsets') {
        if (!p.campaign_id || !byId.has(String(p.campaign_id))) return fail('Invalid campaign id.');
        const o = add(parts[0], 'adsets', { ...p, effective_status: p.status, updated_time: now() });
        return ok({ id: o.id });
      }
      if (edge === 'adcreatives') {
        const spec = p.object_story_spec as { page_id?: string; link_data?: { name?: string; message?: string; call_to_action?: { type?: string }; image_hash?: string }; video_data?: { title?: string; call_to_action?: { type?: string } } } | undefined;
        if (!spec?.page_id) return fail('A Facebook Page is required for this ad creative.');
        const ld = spec.link_data ?? spec.video_data;
        const o = add(parts[0], 'adcreatives', { name: p.name, object_type: spec.video_data ? 'VIDEO' : 'SHARE', title: (ld as { name?: string; title?: string })?.name ?? (ld as { title?: string })?.title, body: (ld as { message?: string })?.message, call_to_action_type: ld?.call_to_action?.type, thumbnail_url: 'https://placehold.co/120x120/png?text=New', object_story_spec: spec });
        return ok({ id: o.id });
      }
      if (edge === 'ads') {
        const creativeId = (p.creative as { creative_id?: string })?.creative_id;
        const adset = byId.get(String(p.adset_id));
        if (!adset || !creativeId || !byId.has(creativeId)) return fail('Choose a valid ad set and creative.');
        const o = add(parts[0], 'ads', { name: p.name, adset_id: p.adset_id, campaign_id: adset.obj.campaign_id, creative: { id: creativeId }, status: p.status, effective_status: 'PENDING_REVIEW', updated_time: now() });
        return ok({ id: o.id });
      }
      if (edge === 'customaudiences') {
        const o = add(parts[0], 'customaudiences', { name: p.name, subtype: p.subtype, approximate_count_lower_bound: p.subtype === 'LOOKALIKE' ? 2_000_000 : 0, approximate_count_upper_bound: p.subtype === 'LOOKALIKE' ? 2_400_000 : 0, time_updated: Math.floor(Date.now() / 1000) });
        return ok({ id: o.id });
      }
      if (edge === 'adspixels') {
        const o = add(parts[0], 'adspixels', { name: p.name, last_fired_time: null });
        return ok({ id: o.id });
      }
    }
    return fail(`Sandbox does not support ${req.method} ${req.path}.`);
  }

  // /<objectId>, /<objectId>/copies, /<audienceId>/users, /<pixelId>/stats
  const found = parts[0] ? byId.get(parts[0]) : undefined;
  if (!found) return fail('Unsupported request. Object does not exist.', 100);
  const obj = found.obj;
  if (parts.length === 1) {
    if (req.method === 'GET') return ok(obj);
    if (req.method === 'DELETE') {
      obj.status = 'DELETED';
      obj.effective_status = 'DELETED';
      return ok({ success: true });
    }
    for (const k of ['name', 'status', 'daily_budget', 'lifetime_budget']) if (p[k] !== undefined) obj[k] = p[k];
    if (p.status) obj.effective_status = p.status;
    obj.updated_time = now();
    return ok({ success: true });
  }
  if (parts[1] === 'copies' && req.method === 'POST') {
    const copy = add(found.account, found.edge, { ...obj, id: undefined as never, name: `${String(obj.name)} - Copy`, status: 'PAUSED', effective_status: 'PAUSED', updated_time: now() });
    const key = found.edge === 'campaigns' ? 'copied_campaign_id' : found.edge === 'adsets' ? 'copied_adset_id' : 'copied_ad_id';
    return ok({ [key]: copy.id });
  }
  if (parts[1] === 'users' && req.method === 'POST') {
    const rows = ((p.payload as { data?: unknown[] })?.data ?? []).length;
    obj.approximate_count_lower_bound = Number(obj.approximate_count_lower_bound ?? 0) + rows;
    obj.approximate_count_upper_bound = Number(obj.approximate_count_upper_bound ?? 0) + rows;
    return ok({ audience_id: obj.id, num_received: rows, num_invalid_entries: 0 });
  }
  if (parts[1] === 'stats') return ok({ data: [{ start_time: now(), data: [{ value: 'PageView', count: 120 }, { value: 'Lead', count: 7 }] }] });
  return fail(`Sandbox does not support ${req.method} ${req.path}.`);
};
