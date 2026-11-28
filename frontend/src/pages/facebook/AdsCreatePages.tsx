import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImagePlus, Loader2, Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useToast } from '../../components/feedback';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { useFbRows } from './AdsDialogs';
import { OBJECTIVES, useAdsHome } from './shared';

function Back({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} relative="path" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
      <ArrowLeft className="size-4" /> {label}
    </Link>
  );
}

function FormCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && <p className="mb-4 text-xs text-slate-500">{description}</p>}
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value} className={cn('rounded-md px-3 py-1.5 font-medium', value === o.value ? 'bg-white shadow-sm' : 'text-slate-500')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Shows Meta's error in plain words; field errors go next to their fields. */
function FormError({ error }: { error: unknown }) {
  if (error == null) return null;
  const hasFieldErrors = error instanceof ApiError && error.code === 'VALIDATION_ERROR';
  return <Alert>{hasFieldErrors ? 'Some fields need attention (see below).' : errorMessage(error)}</Alert>;
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

// ---------------------------------------------------------------------------

export function NewCampaignPage() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const home = useAdsHome();
  const currency = home.data?.connection?.currency ?? 'INR';
  const [f, setF] = useState({ name: '', objective: 'OUTCOME_TRAFFIC', buyingType: 'AUCTION', budgetMode: 'daily' as 'daily' | 'lifetime' | 'later', budget: '', endTime: '', specialAdCategory: 'NONE', status: 'PAUSED' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/workspaces/${workspace.id}/facebook-ads/campaigns`, {
        name: f.name,
        objective: f.objective,
        buyingType: f.buyingType,
        budgetMode: f.budgetMode,
        budget: f.budgetMode === 'later' ? null : Number(f.budget) || null,
        endTime: f.budgetMode === 'lifetime' ? toIso(f.endTime) : null,
        specialAdCategory: f.specialAdCategory,
        status: f.status,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fbads-list', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['fbads', workspace.id] });
      toast.success('Campaign created');
      navigate('..', { relative: 'path' });
    },
  });
  return (
    <div className="max-w-2xl">
      <Back to=".." label="Back to campaigns" />
      <PageHeader title="New campaign" description={home.data?.connection?.adAccountName ?? undefined} />
      <div className="space-y-4">
        <FormError error={save.error} />
        <FormCard title="Campaign basics" description="Name, objective, and how spending is bought.">
          <Field label="Name" htmlFor="c-name" hint="Choose a name you'll recognise months from now." error={fieldError(save.error, 'name')}>
            <Input id="c-name" autoFocus maxLength={200} placeholder="e.g. Winter sale – Traffic to landing page" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Objective" htmlFor="c-obj" hint={OBJECTIVES.find((o) => o.value === f.objective)?.hint}>
            <Select id="c-obj" value={f.objective} onChange={(e) => set({ objective: e.target.value })}>
              {OBJECTIVES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Buying type" htmlFor="c-buy">
            <Select id="c-buy" value={f.buyingType} onChange={(e) => set({ buyingType: e.target.value })}>
              <option value="AUCTION">Auction (recommended)</option>
              <option value="RESERVED">Reservation</option>
            </Select>
          </Field>
        </FormCard>

        <FormCard title="Budget" description="Set it at the campaign level, or leave it to each ad set.">
          <Segmented
            label="Budget type"
            value={f.budgetMode}
            onChange={(budgetMode) => set({ budgetMode })}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'lifetime', label: 'Lifetime' },
              { value: 'later', label: 'Set later' },
            ]}
          />
          {f.budgetMode === 'later' ? (
            <p className="text-sm text-slate-600">Each ad set gets its own budget.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`${f.budgetMode === 'daily' ? 'Daily' : 'Lifetime'} budget (${currency})`} htmlFor="c-budget" error={fieldError(save.error, 'budget')} hint="Facebook sets a minimum per account; you'll see it if the amount is too low.">
                <Input id="c-budget" type="number" min={1} step="1" inputMode="decimal" placeholder="500" value={f.budget} onChange={(e) => set({ budget: e.target.value })} />
              </Field>
              {f.budgetMode === 'lifetime' && (
                <Field label="Ends" htmlFor="c-end" error={fieldError(save.error, 'endTime')}>
                  <Input id="c-end" type="datetime-local" value={f.endTime} onChange={(e) => set({ endTime: e.target.value })} />
                </Field>
              )}
            </div>
          )}
        </FormCard>

        <FormCard title="Compliance" description="Required declaration for certain regulated categories.">
          <Field label="Special ad category" htmlFor="c-cat" hint={'Choose "None" unless your ads are about housing, employment, credit, elections or politics.'}>
            <Select id="c-cat" value={f.specialAdCategory} onChange={(e) => set({ specialAdCategory: e.target.value })}>
              <option value="NONE">None (default)</option>
              <option value="HOUSING">Housing</option>
              <option value="EMPLOYMENT">Employment</option>
              <option value="CREDIT">Credit</option>
              <option value="ISSUES_ELECTIONS_POLITICS">Social issues, elections or politics</option>
            </Select>
          </Field>
          <Field label="Start status" htmlFor="c-status">
            <Select id="c-status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="PAUSED">Paused (safer: activate once ads are ready)</option>
              <option value="ACTIVE">Active</option>
            </Select>
          </Field>
        </FormCard>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate('..', { relative: 'path' })}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name.trim()}>
            Create campaign
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Location {
  type: 'country' | 'region' | 'city';
  key: string;
  name: string;
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SearchPicker<T extends { name: string }>({ type, label, placeholder, chosen, keyOf, onAdd, onRemove, describe }: { type: 'interests' | 'locations'; label: string; placeholder: string; chosen: T[]; keyOf: (t: T) => string; onAdd: (t: T) => void; onRemove: (t: T) => void; describe?: (t: T) => string }) {
  const { workspace } = useWorkspace();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim());
  const results = useQuery({
    queryKey: ['fbads-search', workspace.id, type, debounced],
    queryFn: () => api.get<{ results: T[] }>(`/workspaces/${workspace.id}/facebook-ads/search/${type}?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  const fresh = (results.data?.results ?? []).filter((r) => !chosen.some((c) => keyOf(c) === keyOf(r)));
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-slate-700">{label}</p>
      {chosen.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chosen.map((c) => (
            <span key={keyOf(c)} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200">
              {c.name}
              <button type="button" onClick={() => onRemove(c)} aria-label={`Remove ${c.name}`} className="text-brand-600 hover:text-brand-900">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <Input aria-label={label} className="pl-9" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        {results.isFetching && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-slate-400" />}
      </div>
      {debounced.length >= 2 && fresh.length > 0 && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          {fresh.map((r) => (
            <li key={keyOf(r)}>
              <button type="button" onClick={() => (onAdd(r), setQ(''))} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span>{r.name}</span>
                {describe && <span className="text-xs text-slate-400">{describe(r)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {debounced.length >= 2 && !results.isFetching && results.data && !fresh.length && <p className="mt-1 text-xs text-slate-500">No matches.</p>}
      {results.error != null && <p className="mt-1 text-xs text-red-600">{errorMessage(results.error)}</p>}
    </div>
  );
}

const GOALS = [
  { value: 'LINK_CLICKS', label: 'Link clicks' },
  { value: 'LANDING_PAGE_VIEWS', label: 'Landing page views' },
  { value: 'CONVERSATIONS', label: 'Conversations (WhatsApp / Messenger)' },
  { value: 'LEAD_GENERATION', label: 'Leads (Instant Forms)' },
  { value: 'REACH', label: 'Reach' },
  { value: 'IMPRESSIONS', label: 'Impressions' },
  { value: 'POST_ENGAGEMENT', label: 'Post engagement' },
  { value: 'THRUPLAY', label: 'Video views (ThruPlay)' },
  { value: 'OFFSITE_CONVERSIONS', label: 'Website conversions (pixel)' },
];
const PLATFORMS = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'audience_network', label: 'Audience Network' },
] as const;

export function NewAdSetPage() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const home = useAdsHome();
  const currency = home.data?.connection?.currency ?? 'INR';
  const campaigns = useFbRows('campaign');
  const [f, setF] = useState({
    campaignId: '',
    name: '',
    budgetMode: 'daily' as 'daily' | 'lifetime' | 'campaign',
    budget: '',
    startTime: '',
    endTime: '',
    locations: [] as Location[],
    ageMin: 18,
    ageMax: 65,
    gender: 'all',
    interests: [] as { id: string; name: string }[],
    placements: 'auto' as 'auto' | 'manual',
    platforms: [] as string[],
    optimizationGoal: 'LINK_CLICKS',
    billingEvent: 'IMPRESSIONS',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    bidAmount: '',
    status: 'PAUSED',
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const campaign = campaigns.data?.find((c) => c.id === f.campaignId);
  const campaignBudget = !!campaign && (campaign.dailyBudget !== null || campaign.lifetimeBudget !== null);
  useEffect(() => {
    if (!campaign) return;
    setF((x) => ({ ...x, budgetMode: campaignBudget ? 'campaign' : x.budgetMode === 'campaign' ? 'daily' : x.budgetMode }));
  }, [campaign, campaignBudget]);

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/workspaces/${workspace.id}/facebook-ads/adsets`, {
        ...f,
        budget: f.budgetMode === 'campaign' ? null : Number(f.budget) || null,
        bidAmount: f.bidStrategy === 'LOWEST_COST_WITHOUT_CAP' ? null : Number(f.bidAmount) || null,
        startTime: toIso(f.startTime),
        endTime: toIso(f.endTime),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fbads-list', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['fbads', workspace.id] });
      toast.success('Ad set created');
      navigate('..', { relative: 'path' });
    },
  });

  return (
    <div className="max-w-2xl">
      <Back to=".." label="Back to ad sets" />
      <PageHeader title="New ad set" description="Who sees the ads, where, and how much to spend." />
      <div className="space-y-4">
        <FormError error={save.error} />
        <FormCard title="Basics">
          <Field label="Campaign" htmlFor="as-c" error={fieldError(save.error, 'campaignId')}>
            {campaigns.isPending ? (
              <Spinner />
            ) : (
              <Select id="as-c" value={f.campaignId} onChange={(e) => set({ campaignId: e.target.value })}>
                <option value="">Choose a campaign…</option>
                {(campaigns.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name" htmlFor="as-name" error={fieldError(save.error, 'name')}>
            <Input id="as-name" maxLength={200} placeholder="e.g. Indore, women 25–50" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </FormCard>

        <FormCard title="Budget and schedule">
          {campaignBudget ? (
            <p className="text-sm text-slate-600">This campaign has its own budget (Advantage campaign budget); Facebook shares it across the ad sets.</p>
          ) : (
            <>
              <Segmented label="Budget type" value={f.budgetMode === 'campaign' ? 'daily' : f.budgetMode} onChange={(budgetMode) => set({ budgetMode })} options={[{ value: 'daily', label: 'Daily' }, { value: 'lifetime', label: 'Lifetime' }]} />
              <Field label={`Budget (${currency})`} htmlFor="as-budget" error={fieldError(save.error, 'budget')}>
                <Input id="as-budget" type="number" min={1} className="sm:w-48" value={f.budget} onChange={(e) => set({ budget: e.target.value })} />
              </Field>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor="as-start" hint="Empty = as soon as it's active">
              <Input id="as-start" type="datetime-local" value={f.startTime} onChange={(e) => set({ startTime: e.target.value })} />
            </Field>
            <Field label="Ends" htmlFor="as-end" error={fieldError(save.error, 'endTime')} hint={f.budgetMode === 'lifetime' ? 'Required for a lifetime budget' : 'Optional'}>
              <Input id="as-end" type="datetime-local" value={f.endTime} onChange={(e) => set({ endTime: e.target.value })} />
            </Field>
          </div>
        </FormCard>

        <FormCard title="Audience">
          <SearchPicker<Location>
            type="locations"
            label="Locations"
            placeholder="Search a country, state or city"
            chosen={f.locations}
            keyOf={(l) => `${l.type}:${l.key}`}
            onAdd={(l) => set({ locations: [...f.locations, l] })}
            onRemove={(l) => set({ locations: f.locations.filter((x) => x !== l) })}
            describe={(l) => l.type}
          />
          {fieldError(save.error, 'locations') && <p className="text-xs text-red-600">{fieldError(save.error, 'locations')}</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Age from" htmlFor="as-amin" error={fieldError(save.error, 'ageMin')}>
              <Input id="as-amin" type="number" min={18} max={65} value={f.ageMin} onChange={(e) => set({ ageMin: Number(e.target.value) || 18 })} />
            </Field>
            <Field label="Age to" htmlFor="as-amax">
              <Input id="as-amax" type="number" min={18} max={65} value={f.ageMax} onChange={(e) => set({ ageMax: Number(e.target.value) || 65 })} />
            </Field>
            <Field label="Gender" htmlFor="as-g">
              <Select id="as-g" value={f.gender} onChange={(e) => set({ gender: e.target.value })}>
                <option value="all">All</option>
                <option value="female">Women</option>
                <option value="male">Men</option>
              </Select>
            </Field>
          </div>
          <SearchPicker<{ id: string; name: string; size?: number | null }>
            type="interests"
            label="Interests (optional)"
            placeholder="Search interests, e.g. dentistry"
            chosen={f.interests}
            keyOf={(i) => i.id}
            onAdd={(i) => set({ interests: [...f.interests, { id: i.id, name: i.name }] })}
            onRemove={(i) => set({ interests: f.interests.filter((x) => x.id !== i.id) })}
            describe={(i) => (i.size ? `${(i.size / 1_000_000).toFixed(1)}M people` : '')}
          />
        </FormCard>

        <FormCard title="Placements">
          <Segmented label="Placements" value={f.placements} onChange={(placements) => set({ placements })} options={[{ value: 'auto', label: 'Automatic (recommended)' }, { value: 'manual', label: 'Manual' }]} />
          {f.placements === 'manual' && (
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => {
                const on = f.platforms.includes(p.value);
                return (
                  <button key={p.value} type="button" onClick={() => set({ platforms: on ? f.platforms.filter((x) => x !== p.value) : [...f.platforms, p.value] })} className={cn('rounded-lg px-3 py-1.5 text-sm ring-1', on ? 'bg-brand-50 font-medium text-brand-800 ring-brand-300' : 'bg-white text-slate-600 ring-slate-200')}>
                    {p.label}
                  </button>
                );
              })}
              {fieldError(save.error, 'platforms') && <p className="w-full text-xs text-red-600">{fieldError(save.error, 'platforms')}</p>}
            </div>
          )}
        </FormCard>

        <FormCard title="Optimisation and delivery">
          <Field label="Optimisation goal" htmlFor="as-goal">
            <Select id="as-goal" value={f.optimizationGoal} onChange={(e) => set({ optimizationGoal: e.target.value })}>
              {GOALS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Billing event" htmlFor="as-bill">
              <Select id="as-bill" value={f.billingEvent} onChange={(e) => set({ billingEvent: e.target.value })}>
                <option value="IMPRESSIONS">Impressions</option>
                <option value="LINK_CLICKS">Link clicks</option>
                <option value="THRUPLAY">ThruPlay</option>
              </Select>
            </Field>
            <Field label="Bid strategy" htmlFor="as-bid">
              <Select id="as-bid" value={f.bidStrategy} onChange={(e) => set({ bidStrategy: e.target.value })}>
                <option value="LOWEST_COST_WITHOUT_CAP">Highest volume (no cap)</option>
                <option value="COST_CAP">Cost per result goal</option>
                <option value="LOWEST_COST_WITH_BID_CAP">Bid cap</option>
              </Select>
            </Field>
          </div>
          {f.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && (
            <Field label={`${f.bidStrategy === 'COST_CAP' ? 'Cost per result' : 'Bid cap'} (${currency})`} htmlFor="as-bidamt" error={fieldError(save.error, 'bidAmount')}>
              <Input id="as-bidamt" type="number" min={1} className="sm:w-48" value={f.bidAmount} onChange={(e) => set({ bidAmount: e.target.value })} />
            </Field>
          )}
          <Field label="Start status" htmlFor="as-status">
            <Select id="as-status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="PAUSED">Paused</option>
              <option value="ACTIVE">Active</option>
            </Select>
          </Field>
        </FormCard>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate('..', { relative: 'path' })}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name.trim() || !f.campaignId}>
            Create ad set
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Upload = { type: 'image'; hash: string; preview: string } | { type: 'video'; videoId: string; preview: string };

function MediaInput({ label, accept, value, onChange }: { label: string; accept: string; value: Upload | null; onChange: (u: Upload | null) => void }) {
  const { workspace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const body = await api.upload<{ type: 'image'; hash: string } | { type: 'video'; videoId: string }>(`/workspaces/${workspace.id}/facebook-ads/media`, file);
      onChange({ ...body, preview: URL.createObjectURL(file) } as Upload);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-slate-700">{label}</p>
      {value ? (
        <div className="flex items-center gap-3">
          {value.type === 'image' ? <img src={value.preview} alt="" className="size-20 rounded-lg object-cover ring-1 ring-slate-200" /> : <video src={value.preview} className="h-20 rounded-lg ring-1 ring-slate-200" muted />}
          <Button variant="ghost" onClick={() => onChange(null)}>
            Replace
          </Button>
        </div>
      ) : (
        <label className={cn('flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-sm text-slate-500 hover:border-brand-400', busy && 'pointer-events-none opacity-60')}>
          {busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" strokeWidth={1.5} />}
          {busy ? 'Uploading to Facebook…' : 'Choose a file'}
          <input type="file" accept={accept} className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </label>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const CTA_OPTIONS = [
  { value: 'LEARN_MORE', label: 'Learn more' },
  { value: 'BOOK_NOW', label: 'Book now' },
  { value: 'SIGN_UP', label: 'Sign up' },
  { value: 'SHOP_NOW', label: 'Shop now' },
  { value: 'CONTACT_US', label: 'Contact us' },
  { value: 'GET_OFFER', label: 'Get offer' },
  { value: 'APPLY_NOW', label: 'Apply now' },
  { value: 'GET_QUOTE', label: 'Get quote' },
  { value: 'CALL_NOW', label: 'Call now' },
];

export function NewCreativePage() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const pages = useQuery({ queryKey: ['fbads-pages', workspace.id], queryFn: () => api.get<{ pages: { id: string; name: string }[] }>(`/workspaces/${workspace.id}/facebook-ads/pages`) });
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
  const [media, setMedia] = useState<Upload | null>(null);
  const [thumb, setThumb] = useState<Upload | null>(null);
  const [f, setF] = useState({ name: '', pageId: '', primaryText: '', headline: '', description: '', destination: 'whatsapp' as 'whatsapp' | 'website', link: '', cta: 'LEARN_MORE' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  useEffect(() => {
    if (!f.pageId && pages.data?.pages[0]) setF((x) => ({ ...x, pageId: pages.data!.pages[0]!.id }));
  }, [pages.data, f.pageId]);

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/workspaces/${workspace.id}/facebook-ads/creatives`, {
        name: f.name,
        pageId: f.pageId,
        media: media?.type === 'image' ? { type: 'image', hash: media.hash } : { type: 'video', videoId: media?.type === 'video' ? media.videoId : '', thumbnailHash: thumb?.type === 'image' ? thumb.hash : '' },
        primaryText: f.primaryText,
        headline: f.headline,
        description: f.description,
        destination: f.destination,
        link: f.destination === 'website' ? f.link || null : null,
        cta: f.cta,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fbads-list', workspace.id] });
      toast.success('Creative created');
      navigate('..', { relative: 'path' });
    },
  });

  const ready = f.name.trim() && f.pageId && media && f.primaryText.trim() && (mediaType === 'image' || thumb) && (f.destination === 'whatsapp' || f.link.trim());
  return (
    <div className="max-w-2xl">
      <Back to=".." label="Back to creatives" />
      <PageHeader title="New creative" description="The image or video, the words, and where a tap takes people." />
      <div className="space-y-4">
        <FormError error={save.error} />
        <FormCard title="Basics">
          <Field label="Name" htmlFor="cr-name" error={fieldError(save.error, 'name')}>
            <Input id="cr-name" maxLength={200} placeholder="e.g. Free check-up – WhatsApp" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Facebook Page" htmlFor="cr-page" hint="Ads run in the name of this Page." error={fieldError(save.error, 'pageId')}>
            {pages.isPending ? (
              <Spinner />
            ) : pages.error ? (
              <Alert>{errorMessage(pages.error)}</Alert>
            ) : (
              <Select id="cr-page" value={f.pageId} onChange={(e) => set({ pageId: e.target.value })}>
                {pages.data.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </FormCard>

        <FormCard title="Media">
          <Segmented label="Media type" value={mediaType} onChange={(t) => (setMediaType(t), setMedia(null), setThumb(null))} options={[{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }]} />
          {mediaType === 'image' ? (
            <MediaInput label="Image (JPG or PNG, 1080×1080 works everywhere)" accept="image/jpeg,image/png" value={media} onChange={setMedia} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <MediaInput label="Video (MP4 or MOV)" accept="video/mp4,video/quicktime" value={media} onChange={setMedia} />
              <MediaInput label="Thumbnail image" accept="image/jpeg,image/png" value={thumb} onChange={setThumb} />
            </div>
          )}
        </FormCard>

        <FormCard title="Text">
          <Field label="Primary text" htmlFor="cr-text" error={fieldError(save.error, 'primaryText')}>
            <textarea id="cr-text" rows={3} maxLength={2000} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-600 focus:ring-3 focus:ring-brand-600/15 focus:outline-none" placeholder="Book your free dental check-up this week." value={f.primaryText} onChange={(e) => set({ primaryText: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Headline" htmlFor="cr-head">
              <Input id="cr-head" maxLength={255} value={f.headline} onChange={(e) => set({ headline: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="cr-desc">
              <Input id="cr-desc" maxLength={255} value={f.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </div>
        </FormCard>

        <FormCard title="Where a tap goes">
          <Segmented label="Destination" value={f.destination} onChange={(destination) => set({ destination })} options={[{ value: 'whatsapp', label: 'WhatsApp chat' }, { value: 'website', label: 'Website' }]} />
          {f.destination === 'whatsapp' ? (
            <p className="text-sm text-slate-600">Click-to-WhatsApp: the button opens a chat with the WhatsApp number linked to this Page, and the conversation lands in your Team Inbox.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Website link" htmlFor="cr-link" error={fieldError(save.error, 'link')}>
                <Input id="cr-link" type="url" placeholder="https://…" value={f.link} onChange={(e) => set({ link: e.target.value.trim() })} />
              </Field>
              <Field label="Button" htmlFor="cr-cta">
                <Select id="cr-cta" value={f.cta} onChange={(e) => set({ cta: e.target.value })}>
                  {CTA_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </FormCard>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate('..', { relative: 'path' })}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!ready}>
            Create creative
          </Button>
        </div>
      </div>
    </div>
  );
}
