import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Database,
  ExternalLink,
  Link2,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { TemplatePreview } from '../../components/TemplatePreview';
import { TemplateExtrasFields, buttonValueLabel, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type MessageTemplate, type SheetCampaign, type SheetSyncResult, type SheetVariable, type TemplateExtras } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import type { SheetCampaignList } from './SheetCampaignsPage';
import { CategoryBadge, DELAY_OPTIONS } from './sheetUi';

const STEPS = [
  { key: 'start', label: 'Start' },
  { key: 'link', label: 'Sheet link' },
  { key: 'connect', label: 'Connect' },
  { key: 'select', label: 'Select Sheet' },
  { key: 'map', label: 'Map Columns' },
  { key: 'settings', label: 'Settings' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];
const stepIndex = (k: StepKey) => STEPS.findIndex((s) => s.key === k);

interface Tab {
  gid: string;
  title: string;
}
interface Preview {
  tab: Tab;
  headers: string[];
  rows: Record<string, string>[];
  total: number;
  detected: { phoneColumn: string | null; nameColumn: string | null };
}

/** "Connect Google Sheet": a 6-step wizard; the campaign exists from step 2 on. */
export function SheetSetupPage() {
  const { campaignId } = useParams();
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['sheet-campaign', workspace.id, campaignId],
    queryFn: () => api.get<{ campaign: SheetCampaign }>(`/workspaces/${workspace.id}/integrations/google-sheets/${campaignId}`),
    enabled: !!campaignId,
  });
  if (campaignId && query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  return <Wizard key={campaignId ?? 'new'} campaign={query.data?.campaign ?? null} />;
}

function Wizard({ campaign: initial }: { campaign: SheetCampaign | null }) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const base = `/workspaces/${workspace.id}/integrations/google-sheets`;
  const [campaign, setCampaign] = useState(initial);
  const requested = params.get('step') as StepKey | null;
  const [step, setStepState] = useState<StepKey>(requested && stepIndex(requested) >= 0 ? requested : initial ? (initial.status === 'draft' ? initial.step : 'map') : 'start');
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const googleResult = params.get('google');
  const bodyRef = useRef<HTMLDivElement>(null);

  const setStep = (s: StepKey) => {
    setStepState(s);
    bodyRef.current?.scrollTo({ top: 0 });
    if (campaign) setParams({ step: s }, { replace: true });
  };
  const store = (c: SheetCampaign) => {
    setCampaign(c);
    queryClient.setQueryData(['sheet-campaign', workspace.id, c.id], { campaign: c });
    void queryClient.invalidateQueries({ queryKey: ['sheet-campaigns', workspace.id] });
  };
  const exit = () => navigate(`/w/${workspace.id}/integrations/google-sheets`);
  const reached = campaign ? Math.max(stepIndex(campaign.step), stepIndex(step)) : stepIndex(step);

  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-4 border-b border-slate-200 px-6 py-4">
        <p className="w-28 text-xs font-semibold tracking-widest text-slate-500">
          STEP {stepIndex(step) + 1} OF {STEPS.length}
        </p>
        <ol className="flex flex-1 items-start justify-center overflow-x-auto">
          {STEPS.map((s, i) => {
            const done = i < stepIndex(step);
            const current = s.key === step;
            const canJump = !!campaign && i <= reached && i > 0 && i !== stepIndex(step);
            return (
              <li key={s.key} className="flex items-start">
                {i > 0 && <span className={cn('mt-4 h-0.5 w-6 sm:w-14', i <= stepIndex(step) ? 'bg-emerald-400' : 'bg-slate-200')} />}
                <button type="button" disabled={!canJump} onClick={() => setStep(s.key)} className="flex w-16 flex-col items-center gap-1 sm:w-20">
                  <span
                    className={cn(
                      'flex size-8 items-center justify-center rounded-full border-2 text-xs font-semibold',
                      done ? 'border-emerald-400 bg-emerald-50 text-emerald-600' : current ? 'border-slate-800 text-slate-900 ring-4 ring-slate-200' : 'border-slate-200 text-slate-400',
                    )}
                  >
                    {done ? <Check className="size-4" /> : i + 1}
                  </span>
                  <span className={cn('text-center text-[11px] whitespace-nowrap', current ? 'font-semibold text-ink' : done ? 'text-emerald-600' : 'text-slate-400')}>{s.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={exit} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
          <X className="size-4" /> Exit
        </button>
      </header>

      {step === 'start' && <StartStep onNext={() => setStep('link')} bodyRef={bodyRef} />}
      {step === 'link' && (
        <LinkStep
          bodyRef={bodyRef}
          campaign={campaign}
          onBack={() => setStep('start')}
          onDone={(c, created) => {
            store(c);
            if (created) navigate(`/w/${workspace.id}/integrations/google-sheets/${c.id}/setup?step=connect`, { replace: true });
            else setStep('connect');
          }}
        />
      )}
      {campaign && step === 'connect' && (
        <ConnectStep
          bodyRef={bodyRef}
          base={base}
          campaign={campaign}
          googleResult={googleResult}
          onBack={() => setStep('link')}
          onDone={(c, t) => {
            store(c);
            setTabs(t);
            setStep('select');
          }}
        />
      )}
      {campaign && step === 'select' && (
        <SelectStep
          bodyRef={bodyRef}
          base={base}
          campaign={campaign}
          tabs={tabs}
          onBack={() => setStep('connect')}
          onDone={(c) => {
            store(c);
            setStep('map');
          }}
        />
      )}
      {campaign && step === 'map' && (
        <MapStep
          bodyRef={bodyRef}
          base={base}
          campaign={campaign}
          onBack={() => setStep('select')}
          onDone={(c) => {
            store(c);
            setStep('settings');
          }}
        />
      )}
      {campaign && step === 'settings' && (
        <SettingsStep
          bodyRef={bodyRef}
          base={base}
          campaign={campaign}
          onBack={() => setStep('map')}
          onSaved={store}
          onActivated={(c) => {
            store(c);
            navigate(`/w/${workspace.id}/integrations/google-sheets/${c.id}/data`);
          }}
        />
      )}
    </div>
  );
}

// ---- Shared step frame ----

function StepFrame({ bodyRef, title, subtitle, children, footer }: { bodyRef: React.RefObject<HTMLDivElement | null>; title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center text-2xl font-bold text-ink">{title}</h2>
          <p className="mx-auto mt-1.5 max-w-lg text-center text-slate-500">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">{footer}</footer>
    </>
  );
}

const BackButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="secondary" onClick={onClick}>
    <ChevronLeft className="size-4" /> Back
  </Button>
);

const NextButton = ({ label = 'Next Step', ...props }: { label?: string; loading?: boolean; disabled?: boolean; onClick: () => void }) => (
  <Button {...props} className="bg-slate-700 px-5 py-2.5 hover:bg-slate-800">
    {label} <ChevronRight className="size-4" />
  </Button>
);

function InfoCard({ icon, tone, title, children }: { icon: ReactNode; tone: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-slate-200 p-4">
      <span className={cn('h-fit rounded-lg p-2', tone)}>{icon}</span>
      <div className="text-sm text-slate-600">
        <p className="mb-1 font-semibold text-ink">{title}</p>
        {children}
      </div>
    </div>
  );
}

// ---- Step 1 ----

function StartStep({ onNext, bodyRef }: { onNext: () => void; bodyRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Connect Your Google Sheet"
      subtitle="Connect your sheet, pick a template, and start sending messages — all in under 2 minutes."
      footer={
        <>
          <span />
          <NextButton label="Get Started" onClick={onNext} />
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard icon={<Zap className="size-4" />} tone="bg-indigo-50 text-indigo-600" title="How it works">
          Every new row triggers a WhatsApp message automatically — no manual sending. Each row uses one message credit. Edits to the sheet are picked up live, about once a minute.
        </InfoCard>
        <InfoCard icon={<AlertTriangle className="size-4" />} tone="bg-amber-50 text-amber-600" title="Before you begin">
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              A <b>WhatsApp template</b> created &amp; approved
            </li>
            <li>
              Your sheet <b>shared with a link</b>, or your <b>Google account</b> ready for step 3
            </li>
          </ul>
        </InfoCard>
        <InfoCard icon={<Database className="size-4" />} tone="bg-sky-50 text-sky-600" title="Prepare Your Sheet">
          Make sure your sheet has a phone number column with country codes (e.g. 919876543210).
          <p className="mt-1.5">
            Name it <b>Phone</b>, <b>Mobile</b>, or <b>WhatsApp</b> — it will be auto-detected.
          </p>
        </InfoCard>
        <InfoCard icon={<Sparkles className="size-4" />} tone="bg-fuchsia-50 text-fuchsia-600" title="Format Your Sheet">
          Row 1 must be column headers (e.g. Name, Phone) — these are mapped to your message template variables.
        </InfoCard>
      </div>
      <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
        <p className="mb-2 text-xs font-bold tracking-wide text-emerald-800">QUICK CHECKLIST</p>
        {['Phone numbers include country code (e.g. 91XXXXXXXXXX)', 'No merged cells in the sheet', 'Headers in row 1, data starts from row 2', 'Each phone number gets the message once per campaign'].map((t) => (
          <p key={t} className="flex items-center gap-2 py-0.5 text-sm text-emerald-800">
            <CheckCircle2 className="size-4 text-emerald-500" /> {t}
          </p>
        ))}
      </div>
    </StepFrame>
  );
}

// ---- Step 2 ----

function LinkStep({ campaign, bodyRef, onBack, onDone }: { campaign: SheetCampaign | null; bodyRef: React.RefObject<HTMLDivElement | null>; onBack: () => void; onDone: (c: SheetCampaign, created: boolean) => void }) {
  const { workspace } = useWorkspace();
  const base = `/workspaces/${workspace.id}/integrations/google-sheets`;
  const [url, setUrl] = useState(campaign?.sheetUrl ?? '');
  const valid = /docs\.google\.com\/spreadsheets\/(u\/\d+\/)?d\/[\w-]{20,}/.test(url);
  const save = useMutation({
    mutationFn: async () => {
      if (!campaign) return { c: (await api.post<{ campaign: SheetCampaign }>(base, { sheetUrl: url.trim() })).campaign, created: true };
      const c = url.trim() === campaign.sheetUrl ? campaign : (await api.patch<{ campaign: SheetCampaign }>(`${base}/${campaign.id}`, { sheetUrl: url.trim() })).campaign;
      return { c, created: false };
    },
    onSuccess: ({ c, created }) => onDone(c, created),
  });
  const paste = async () => {
    try {
      setUrl((await navigator.clipboard.readText()).trim());
    } catch {
      /* clipboard blocked: the user pastes by hand */
    }
  };
  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Start with your Google Sheet"
      subtitle="Paste the link to your Google Sheet."
      footer={
        <>
          <BackButton onClick={onBack} />
          <NextButton loading={save.isPending} disabled={!valid} onClick={() => save.mutate()} />
        </>
      }
    >
      <div className="mx-auto max-w-md space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="sheet-url" className="text-sm font-medium text-slate-700">
            Your Google Sheet link
          </label>
          <button type="button" onClick={() => void paste()} className="inline-flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-ink">
            <ClipboardPaste className="size-4" /> Paste
          </button>
        </div>
        <Input
          id="sheet-url"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && save.mutate()}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          invalid={!!url && !valid}
        />
        <p className="text-xs text-slate-500">{url && !valid ? 'This does not look like a Google Sheets link.' : "Open your sheet in Google Sheets and copy the link from your browser's address bar."}</p>
        {save.error != null && <Alert>{fieldError(save.error, 'sheetUrl') ?? errorMessage(save.error)}</Alert>}
        <div className="flex gap-2 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          Ensure your sheet is accessible. We'll check access in the next step.
        </div>
      </div>
    </StepFrame>
  );
}

// ---- Step 3 ----

function ConnectStep({
  base,
  campaign,
  googleResult,
  bodyRef,
  onBack,
  onDone,
}: {
  base: string;
  campaign: SheetCampaign;
  googleResult: string | null;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onDone: (c: SheetCampaign, tabs: Tab[]) => void;
}) {
  const { workspace } = useWorkspace();
  const info = useQuery({ queryKey: ['sheet-campaigns', workspace.id], queryFn: () => api.get<SheetCampaignList>(base) });
  const google = info.data?.google;
  const [access, setAccess] = useState<'link' | 'google'>(campaign.access);
  const [accountId, setAccountId] = useState(campaign.googleAccount?.id ?? '');
  useEffect(() => {
    if (!accountId && google?.accounts[0]) setAccountId(google.accounts[0].id);
  }, [google, accountId]);
  const connect = useMutation({
    mutationFn: () => api.post<{ campaign: SheetCampaign; tabs: Tab[] }>(`${base}/${campaign.id}/connect`, { access, ...(access === 'google' ? { googleAccountId: accountId } : {}) }),
    onSuccess: ({ campaign: c, tabs }) => onDone(c, tabs),
  });
  const signIn = useMutation({
    mutationFn: () => api.get<{ url: string }>(`${base}/google/auth-url?campaignId=${campaign.id}`),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Connect your sheet"
      subtitle="Choose how we read your sheet. We only ever read it — nothing in your sheet is changed."
      footer={
        <>
          <BackButton onClick={onBack} />
          <NextButton label="Check access & continue" loading={connect.isPending} disabled={access === 'google' && !accountId} onClick={() => connect.mutate()} />
        </>
      }
    >
      <div className="mx-auto max-w-2xl space-y-3">
        {googleResult === 'connected' && <Alert tone="success">Google account connected. Check access to continue.</Alert>}
        {(googleResult === 'denied' || googleResult === 'failed') && <Alert>Google sign-in did not complete. Try again, or use link sharing.</Alert>}
        {connect.error != null && <Alert>{errorMessage(connect.error)}</Alert>}

        <AccessOption checked={access === 'link'} onSelect={() => setAccess('link')} icon={<Link2 className="size-5" />} title="Anyone with the link can view" badge="Recommended">
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-slate-600">
            <li>
              Open{' '}
              <a href={campaign.sheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-700 hover:underline">
                your sheet <ExternalLink className="size-3" />
              </a>{' '}
              and click <b>Share</b>.
            </li>
            <li>
              Under <b>General access</b>, choose <b>Anyone with the link</b>.
            </li>
            <li>
              Keep the role as <b>Viewer</b> and click <b>Done</b>.
            </li>
          </ol>
        </AccessOption>

        <AccessOption checked={access === 'google'} onSelect={() => setAccess('google')} icon={<GoogleG />} title="Sign in with Google" badge="Private sheets" disabled={!google?.configured && !google?.accounts.length}>
          {!google?.configured && !google?.accounts.length ? (
            <p className="mt-1 text-sm text-slate-500">Google sign-in is not set up on this server yet (an admin adds a Google OAuth client). Use link sharing for now.</p>
          ) : (
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-slate-600">Keep the sheet private; we read it with read-only access to your Google account.</p>
              {google.accounts.length > 0 && (
                <Select aria-label="Google account" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={access !== 'google'}>
                  {google.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </Select>
              )}
              {google.configured && (
                <Button variant="secondary" loading={signIn.isPending} onClick={() => signIn.mutate()}>
                  <GoogleG /> {google.accounts.length ? 'Connect another account' : 'Connect Google account'}
                </Button>
              )}
              {signIn.error != null && <Alert>{errorMessage(signIn.error)}</Alert>}
            </div>
          )}
        </AccessOption>
      </div>
    </StepFrame>
  );
}

function AccessOption({ checked, onSelect, icon, title, badge, disabled, children }: { checked: boolean; onSelect: () => void; icon: ReactNode; title: string; badge: string; disabled?: boolean; children: ReactNode }) {
  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => e.key === ' ' && !disabled && onSelect()}
      className={cn('flex cursor-pointer gap-3 rounded-2xl border-2 p-4 transition', checked ? 'border-emerald-500 bg-emerald-50/30' : 'border-slate-200 hover:border-slate-300', disabled && 'cursor-not-allowed opacity-60')}
    >
      <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2', checked ? 'border-emerald-500' : 'border-slate-300')}>{checked && <span className="size-2.5 rounded-full bg-emerald-500" />}</span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
          <span className="text-slate-500">{icon}</span> {title}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{badge}</span>
        </p>
        {children}
      </div>
    </div>
  );
}

const GoogleG = () => (
  <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
  </svg>
);

// ---- Step 4 ----

function SelectStep({ base, campaign, tabs: knownTabs, bodyRef, onBack, onDone }: { base: string; campaign: SheetCampaign; tabs: Tab[] | null; bodyRef: React.RefObject<HTMLDivElement | null>; onBack: () => void; onDone: (c: SheetCampaign) => void }) {
  const tabsQuery = useQuery({ queryKey: ['sheet-tabs', campaign.id], queryFn: () => api.get<{ tabs: Tab[] }>(`${base}/${campaign.id}/tabs`), enabled: !knownTabs });
  const tabs = knownTabs ?? tabsQuery.data?.tabs ?? null;
  const [gid, setGid] = useState<string | null>(campaign.tab?.gid ?? null);
  useEffect(() => {
    if (!gid && tabs?.[0]) setGid(tabs[0].gid);
  }, [tabs, gid]);
  const preview = useQuery({ queryKey: ['sheet-preview', campaign.id, gid], queryFn: () => api.get<Preview>(`${base}/${campaign.id}/preview?gid=${gid}`), enabled: !!gid });
  const [phone, setPhone] = useState<string | null>(campaign.phoneColumn);
  const [name, setName] = useState<string | null>(campaign.nameColumn);
  // Use the detected columns when the saved ones aren't in this tab.
  useEffect(() => {
    if (!preview.data) return;
    const h = preview.data.headers;
    setPhone((p) => (p && h.includes(p) ? p : preview.data.detected.phoneColumn));
    setName((n) => (n && h.includes(n) ? n : preview.data.detected.nameColumn));
  }, [preview.data]);
  const save = useMutation({
    mutationFn: () => api.post<{ campaign: SheetCampaign }>(`${base}/${campaign.id}/tab`, { gid, phoneColumn: phone, nameColumn: name }),
    onSuccess: ({ campaign: c }) => onDone(c),
  });
  const locked = campaign.status !== 'draft';

  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Select your sheet"
      subtitle={`${campaign.spreadsheetTitle || 'Your spreadsheet'} — pick the tab with your contacts, then confirm the phone column.`}
      footer={
        <>
          <BackButton onClick={onBack} />
          <NextButton loading={save.isPending} disabled={!gid || !phone || !preview.data} onClick={() => save.mutate()} />
        </>
      }
    >
      <div className="space-y-5">
        {(tabsQuery.error ?? preview.error ?? save.error) != null && <Alert>{errorMessage(tabsQuery.error ?? preview.error ?? save.error)}</Alert>}
        {!tabs ? (
          <Spinner label="Reading your sheet…" />
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            {tabs.map((t) => (
              <button
                key={t.gid}
                type="button"
                disabled={locked && t.gid !== campaign.tab?.gid}
                onClick={() => setGid(t.gid)}
                className={cn('inline-flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition disabled:opacity-40', gid === t.gid ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700 hover:border-slate-300')}
              >
                <Table2 className="size-4" /> {t.title}
              </button>
            ))}
          </div>
        )}
        {locked && <p className="text-center text-xs text-slate-500">The tab can't be changed after a campaign has started. Create a new campaign for another tab.</p>}

        {preview.isFetching && !preview.data ? (
          <Spinner label="Loading rows…" />
        ) : preview.data ? (
          <>
            {!preview.data.headers.length ? (
              <Alert>This tab is empty. Add headers in row 1 (e.g. Name, Phone) and try again.</Alert>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium text-slate-700">Phone number column</span>
                    <Select value={phone ?? ''} onChange={(e) => setPhone(e.target.value || null)}>
                      <option value="">Choose a column</option>
                      {preview.data.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                    {preview.data.detected.phoneColumn && phone === preview.data.detected.phoneColumn && <span className="flex items-center gap-1 text-xs text-emerald-700"><Sparkles className="size-3" /> Auto-detected</span>}
                  </label>
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium text-slate-700">Name column (optional)</span>
                    <Select value={name ?? ''} onChange={(e) => setName(e.target.value || null)}>
                      <option value="">None</option>
                      {preview.data.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                    <span className="block text-xs text-slate-500">Saved as the contact's name when they're new.</span>
                  </label>
                </div>
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between bg-slate-50 px-4 py-2 text-xs text-slate-500">
                    <span className="font-medium">Preview · {preview.data.tab.title}</span>
                    <span>{preview.data.total} row(s) with data</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-slate-500">
                        <tr>
                          {preview.data.headers.map((h) => (
                            <th key={h} className={cn('px-3 py-2 font-medium whitespace-nowrap', h === phone && 'bg-emerald-50 text-emerald-700')}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {preview.data.rows.map((r, i) => (
                          <tr key={i}>
                            {preview.data.headers.map((h) => (
                              <td key={h} className={cn('max-w-48 truncate px-3 py-2 text-slate-700', h === phone && 'bg-emerald-50/50 font-mono text-xs')}>
                                {r[h] || <span className="text-slate-300">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {!preview.data.rows.length && (
                          <tr>
                            <td colSpan={preview.data.headers.length} className="px-3 py-4 text-center text-xs text-slate-500">
                              No rows yet — new rows will be picked up once the campaign is live.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </StepFrame>
  );
}

// ---- Step 5 ----

const emptyVar = (): SheetVariable => ({ source: 'column', value: '' });
const fit = (list: SheetVariable[], n: number) => Array.from({ length: n }, (_, i) => list[i] ?? emptyVar());

function MapStep({ base, campaign, bodyRef, onBack, onDone }: { base: string; campaign: SheetCampaign; bodyRef: React.RefObject<HTMLDivElement | null>; onBack: () => void; onDone: (c: SheetCampaign) => void }) {
  const { workspace } = useWorkspace();
  const templates = useQuery({ queryKey: ['templates', workspace.id, 'approved'], queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`) });
  const sample = useQuery({ queryKey: ['sheet-preview', campaign.id, campaign.tab?.gid], queryFn: () => api.get<Preview>(`${base}/${campaign.id}/preview?gid=${campaign.tab?.gid}`), enabled: !!campaign.tab });
  const [templateId, setTemplateId] = useState(campaign.templateId);
  const template = templates.data?.templates.find((t) => t.id === templateId) ?? null;
  const req = template?.requirements;
  const [header, setHeader] = useState(campaign.headerVariables);
  const [body, setBody] = useState(campaign.bodyVariables);
  const [buttons, setButtons] = useState(campaign.buttonVariables);
  const [extras, setExtras] = useState<TemplateExtras>(campaign.templateExtras ?? {});

  const choose = (t: MessageTemplate) => {
    setTemplateId(t.id);
    // Guess sensible columns: the name column for the first variable.
    const first = campaign.nameColumn ? { source: 'column' as const, value: campaign.nameColumn } : emptyVar();
    setHeader(fit([], t.requirements.header));
    setBody(fit(t.requirements.body ? [first] : [], t.requirements.body));
    setButtons(fit([], t.requirements.buttons.length));
    setExtras(emptyExtras(t.requirements));
  };
  const save = useMutation({
    mutationFn: () =>
      api.patch<{ campaign: SheetCampaign }>(`${base}/${campaign.id}`, {
        templateId,
        headerVariables: fit(header, req?.header ?? 0),
        bodyVariables: fit(body, req?.body ?? 0),
        buttonVariables: fit(buttons, req?.buttons.length ?? 0),
        templateExtras: extras,
        step: 'settings',
      }),
    onSuccess: ({ campaign: c }) => onDone(c),
  });
  const row = sample.data?.rows[0] ?? {};
  const sampleOf = (v: SheetVariable, i: number) => (v.source === 'static' ? v.value : v.value ? row[v.value] || v.fallback || `{${v.value}}` : `{{${i + 1}}}`);
  const complete = !!template && [...fit(header, req!.header), ...fit(body, req!.body), ...fit(buttons, req!.buttons.length)].every((v) => v.value.trim());

  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Map Your Template"
      subtitle="Pick a template, then configure each component."
      footer={
        <>
          <BackButton onClick={onBack} />
          <NextButton loading={save.isPending} disabled={!complete} onClick={() => save.mutate()} />
        </>
      }
    >
      <div className="space-y-6">
        <TemplatePicker templates={templates.data?.templates} loading={templates.isPending} value={template} onChange={choose} />
        {templates.data && !templates.data.templates.length && (
          <Alert tone="info">
            No approved templates yet.{' '}
            <Link to={`/w/${workspace.id}/templates/new`} className="font-medium underline">
              Create one
            </Link>{' '}
            and come back once WhatsApp approves it.
          </Alert>
        )}
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}

        {template && req && (
          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="space-y-5">
              {req.header > 0 && (
                <VarGroup title="Header">
                  {fit(header, req.header).map((v, i) => (
                    <SheetVariableRow key={i} label={`{{${i + 1}}}`} value={v} headers={campaign.headers} onChange={(nv) => setHeader(fit(header, req.header).map((x, j) => (j === i ? nv : x)))} />
                  ))}
                </VarGroup>
              )}
              {req.body > 0 && (
                <VarGroup title="Body">
                  {fit(body, req.body).map((v, i) => (
                    <SheetVariableRow key={i} label={`{{${i + 1}}}`} value={v} headers={campaign.headers} onChange={(nv) => setBody(fit(body, req.body).map((x, j) => (j === i ? nv : x)))} />
                  ))}
                </VarGroup>
              )}
              {req.buttons.length > 0 && (
                <VarGroup title="Buttons">
                  {req.buttons.map((b, i) => (
                    <SheetVariableRow key={i} label={buttonValueLabel(b)} value={fit(buttons, req.buttons.length)[i]!} headers={campaign.headers} onChange={(nv) => setButtons(fit(buttons, req.buttons.length).map((x, j) => (j === i ? nv : x)))} />
                  ))}
                </VarGroup>
              )}
              {req.header + req.body + req.buttons.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">This template has no variables — every row gets the same message.</p>}
              <TemplateExtrasFields requirements={req} value={extras} onChange={setExtras} error={save.error} shared />
            </div>
            <div className="lg:sticky lg:top-0">
              <p className="mb-2 text-xs font-medium text-slate-500">Preview {sample.data?.rows[0] ? '(first row of your sheet)' : ''}</p>
              <TemplatePreview components={template.components} headerParams={fit(header, req.header).map(sampleOf)} bodyParams={fit(body, req.body).map(sampleOf)} {...extrasPreview(extras)} />
            </div>
          </div>
        )}
      </div>
    </StepFrame>
  );
}

function VarGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200">
      <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <div className="space-y-3 p-4">{children}</div>
    </div>
  );
}

/** One template value: a sheet column (with a fallback for empty cells) or fixed text. */
function SheetVariableRow({ label, value, headers, onChange }: { label: string; value: SheetVariable; headers: string[]; onChange: (v: SheetVariable) => void }) {
  return (
    <div className="grid items-start gap-2 sm:grid-cols-[minmax(3rem,auto)_1fr_1fr]">
      <span className="pt-2 font-mono text-xs text-slate-500">{label}</span>
      <Select
        aria-label={`${label} source`}
        value={value.source === 'static' ? '__static' : value.value}
        onChange={(e) => onChange(e.target.value === '__static' ? { source: 'static', value: '' } : { source: 'column', value: e.target.value, fallback: value.fallback ?? null })}
      >
        <option value="">Choose a column</option>
        <optgroup label="Sheet columns">
          {headers.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </optgroup>
        <option value="__static">Custom text…</option>
      </Select>
      {value.source === 'static' ? (
        <Input aria-label={`${label} text`} placeholder="Same text for every row" value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
      ) : (
        <Input aria-label={`${label} fallback`} placeholder="If the cell is empty (optional)" value={value.fallback ?? ''} onChange={(e) => onChange({ ...value, fallback: e.target.value || null })} />
      )}
    </div>
  );
}

function TemplatePicker({ templates, loading, value, onChange }: { templates?: MessageTemplate[]; loading: boolean; value: MessageTemplate | null; onChange: (t: MessageTemplate) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const list = useMemo(() => (templates ?? []).filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())), [templates, q]);
  const pretty = (n: string) => n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div ref={ref} className="relative">
      <p className="mb-1.5 text-sm font-semibold text-ink">
        Select Template <span className="font-normal text-slate-500">({templates?.length ?? 0} available)</span>
      </p>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-left text-sm hover:border-slate-400">
        {value ? (
          <span className="flex items-center gap-2">
            <span className="font-medium text-ink">{pretty(value.name)}</span> <span className="text-xs text-slate-400">{value.language}</span>
          </span>
        ) : (
          <span className="text-slate-400">{loading ? 'Loading templates…' : 'Search and select a template...'}</span>
        )}
        <ChevronDown className="size-4 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="relative border-b border-slate-100 p-2">
            <Search className="pointer-events-none absolute top-4.5 left-5 size-4 text-slate-400" />
            <Input autoFocus aria-label="Search templates" placeholder="Search templates by name..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <ul className="max-h-72 overflow-y-auto p-1">
            {list.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(t);
                    setOpen(false);
                  }}
                  className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm hover:bg-slate-50', value?.id === t.id && 'bg-emerald-50')}
                >
                  <span>
                    <span className="text-slate-800">{pretty(t.name)}</span> <span className="text-xs text-slate-400">{t.language}</span>
                  </span>
                  <CategoryBadge category={t.category} />
                </button>
              </li>
            ))}
            {!list.length && <li className="px-3 py-4 text-center text-sm text-slate-500">No approved templates match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---- Step 6 ----

function SettingsStep({
  base,
  campaign,
  bodyRef,
  onBack,
  onSaved,
  onActivated,
}: {
  base: string;
  campaign: SheetCampaign;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onSaved: (c: SheetCampaign) => void;
  onActivated: (c: SheetCampaign) => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [delay, setDelay] = useState(campaign.sendDelayMinutes);
  const [startFrom, setStartFrom] = useState(campaign.startFrom);
  const started = campaign.status !== 'draft';
  const patch = () => api.patch<{ campaign: SheetCampaign }>(`${base}/${campaign.id}`, { name: name.trim() || campaign.name, sendDelayMinutes: delay, ...(started ? {} : { startFrom }) });
  const save = useMutation({ mutationFn: patch, onSuccess: ({ campaign: c }) => onSaved(c) });
  const activate = useMutation({
    mutationFn: async () => {
      onSaved((await patch()).campaign);
      return api.post<{ campaign: SheetCampaign; sync: SheetSyncResult }>(`${base}/${campaign.id}/activate`);
    },
    onSuccess: ({ campaign: c }) => onActivated(c),
  });
  const error = activate.error ?? save.error;
  const details = error && typeof error === 'object' && 'details' in error ? Object.values((error as { details?: Record<string, string[]> }).details ?? {}).flat() : [];

  return (
    <StepFrame
      bodyRef={bodyRef}
      title="Campaign settings"
      subtitle="Name it, choose when messages go out, and go live."
      footer={
        <>
          <BackButton onClick={onBack} />
          <div className="flex gap-2">
            <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>
              {started ? 'Save changes' : 'Save as draft'}
            </Button>
            <NextButton label={campaign.status === 'active' ? 'Save & sync now' : campaign.status === 'paused' ? 'Save & resume' : 'Activate campaign'} loading={activate.isPending} onClick={() => activate.mutate()} />
          </div>
        </>
      }
    >
      <div className="mx-auto max-w-xl space-y-5">
        {error != null && (
          <Alert>
            {errorMessage(error)}
            {details.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        {save.isSuccess && !activate.isPending && <Alert tone="success">Saved.</Alert>}
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-slate-700">Campaign name</span>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-slate-700">Send delay</span>
          <Select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
            {DELAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value ? `${o.label} after the row is added` : 'Instant (within about a minute)'}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="space-y-2" disabled={started}>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">Rows already in the sheet</legend>
          {(
            [
              ['new', 'Only new rows', 'Rows in the sheet today are skipped; only rows added from now on get the message.'],
              ['all', 'Send to existing rows too', 'Everyone already in the sheet gets the message as soon as you activate.'],
            ] as const
          ).map(([v, title, hint]) => (
            <label key={v} className={cn('flex cursor-pointer gap-3 rounded-xl border-2 p-3', startFrom === v ? 'border-emerald-500 bg-emerald-50/30' : 'border-slate-200')}>
              <input type="radio" className="mt-1 accent-emerald-600" checked={startFrom === v} onChange={() => setStartFrom(v)} />
              <span>
                <span className="block text-sm font-medium text-ink">{title}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </label>
          ))}
          {started && <p className="text-xs text-slate-500">Fixed once the campaign has started.</p>}
        </fieldset>
        <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          <p className="mb-2 font-semibold text-ink">Summary</p>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt className="text-slate-500">Sheet</dt>
            <dd className="truncate">
              {campaign.spreadsheetTitle} · {campaign.tab?.title}
            </dd>
            <dt className="text-slate-500">Phone column</dt>
            <dd>{campaign.phoneColumn}</dd>
            <dt className="text-slate-500">Template</dt>
            <dd>{campaign.template?.name ?? '—'}</dd>
            <dt className="text-slate-500">Checks</dt>
            <dd>About once a minute, plus whenever you click Sync Data</dd>
          </dl>
        </div>
      </div>
    </StepFrame>
  );
}
