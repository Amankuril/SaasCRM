import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, LogOut, Megaphone, RefreshCw, ScrollText, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { relativeTime } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, useToast } from '../../components/feedback';
import { Alert, Badge, Button, Card, LoadError, PageHeader, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type FbAdAccount, type FbConnectionInfo } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ENTITY_PAGES, useAdsHome } from './shared';

const ACCOUNT_STATUS: Record<number, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' }> = {
  1: { label: 'Active', tone: 'green' },
  2: { label: 'Disabled', tone: 'red' },
  3: { label: 'Unsettled', tone: 'amber' },
  7: { label: 'Pending review', tone: 'amber' },
  9: { label: 'Grace period', tone: 'amber' },
  101: { label: 'Closed', tone: 'gray' },
};

export function AdsHomePage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const home = useAdsHome();
  const manage = can('ads:manage');
  const base = `/workspaces/${workspace.id}/facebook-ads`;
  const [picking, setPicking] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['fbads', workspace.id] });

  // Back from Facebook login.
  useEffect(() => {
    const fb = params.get('fb');
    if (!fb) return;
    if (fb === 'choose') setPicking(true);
    if (fb === 'cancelled') toast.error('Facebook login was cancelled.');
    if (fb === 'expired') toast.error('That login link expired. Try Connect Facebook again.');
    if (fb === 'error') toast.error(`Facebook login failed: ${params.get('message') ?? 'unknown error'}`);
    setParams({}, { replace: true });
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>(`${base}/connect`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (err) => toast.error(err),
  });
  const action = useMutation({
    mutationFn: (a: 'verify' | 'sync' | 'disconnect') => api.post(`${base}/${a}`),
    onSuccess: (_r, a) => {
      void refresh();
      setConfirmDisconnect(false);
      toast.success(a === 'verify' ? 'Connection works.' : a === 'sync' ? 'Sync started. Counters update when it finishes.' : 'Facebook disconnected.');
    },
    onError: (err) => {
      void refresh();
      toast.error(err);
    },
  });

  if (home.isPending) return <Spinner />;
  if (home.error) return <LoadError error={home.error} onRetry={() => void home.refetch()} />;
  const { connection: c, counts } = home.data;

  if (!c || (c.status === 'pending' && !picking && !c.adAccountId)) {
    return (
      <>
        <PageHeader title="Facebook Ads" description="Manage campaigns, ad sets, creatives and audiences from Zeta Connect, and follow up Lead Ads on WhatsApp." />
        <Card className="mx-auto max-w-xl p-8 text-center">
          <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-[#1877f2]/10 text-[#1877f2]">
            <Megaphone className="size-6" strokeWidth={1.5} />
          </span>
          <h2 className="text-lg font-medium text-ink">{c?.status === 'pending' ? 'Choose your ad account' : 'Connect your Meta ad account'}</h2>
          <p className="mt-2 text-sm text-slate-600">Log in with Facebook and pick the ad account to manage. Zeta Connect only uses the permissions you approve, and you can disconnect at any time.</p>
          {manage ? (
            <Button className="mt-5" onClick={() => (c?.status === 'pending' ? setPicking(true) : connect.mutate())} loading={connect.isPending}>
              {c?.status === 'pending' ? 'Choose ad account' : 'Connect Facebook'}
            </Button>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Ask an owner or admin to connect Facebook.</p>
          )}
          {home.data.provider === 'sandbox' && <p className="mt-3 text-xs text-amber-700">Sandbox mode: a test ad account is used instead of Facebook.</p>}
        </Card>
        {picking && <AccountPicker onClose={() => setPicking(false)} />}
      </>
    );
  }

  const broken = c.status === 'error';
  const syncing = ['queued', 'running'].includes(c.sync.status);
  const acct = c.accountStatus !== null ? (ACCOUNT_STATUS[c.accountStatus] ?? { label: `Status ${c.accountStatus}`, tone: 'gray' as const }) : null;

  return (
    <>
      <PageHeader
        title="Facebook Ads"
        description="Manage campaigns, ad sets and creatives from one place."
        actions={
          manage && (
            <>
              <Button variant="secondary" onClick={() => setPicking(true)} disabled={broken}>
                <Building2 className="size-4" /> Change ad account
              </Button>
              <Button variant="secondary" onClick={() => action.mutate('verify')} loading={action.isPending && action.variables === 'verify'}>
                <ShieldCheck className="size-4" /> Verify connection
              </Button>
              <Button variant="secondary" onClick={() => action.mutate('sync')} disabled={broken || syncing}>
                <RefreshCw className={cn('size-4', syncing && 'animate-spin')} /> {syncing ? 'Syncing…' : 'Sync'}
              </Button>
              <Button variant="secondary" onClick={() => setShowLogs(true)}>
                <ScrollText className="size-4" /> Logs
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                <LogOut className="size-4" /> Disconnect
              </Button>
            </>
          )
        }
      />

      {broken && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4" /> The Facebook connection stopped working{c.lastError ? `: ${c.lastError}` : '.'} Changes are blocked until you reconnect.
          </span>
          {manage && (
            <Button variant="danger" onClick={() => connect.mutate()} loading={connect.isPending}>
              Reconnect Facebook
            </Button>
          )}
        </div>
      )}

      <Card className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">Ad account</p>
          <p className="font-medium text-ink">{c.adAccountName ?? 'Not chosen'}</p>
          <p className="text-xs text-slate-500">ID {c.adAccountId?.replace('act_', '') ?? '—'}</p>
        </div>
        <Meta label="Currency" value={c.currency ?? '—'} />
        <Meta label="Timezone" value={c.timezone ?? '—'} />
        <div>
          <p className="text-xs text-slate-500">Status</p>
          {broken ? <Badge tone="red">Reconnect needed</Badge> : acct ? <Badge tone={acct.tone}>{acct.label}</Badge> : '—'}
        </div>
        <Meta label="Token expires" value={c.tokenExpiresAt ? formatDate(c.tokenExpiresAt) : 'Never'} />
        <div className="ml-auto text-right text-xs text-slate-500">
          {c.fbUserName && <p>Connected by {c.fbUserName}</p>}
          <p>{c.sync.finishedAt ? `Last synced ${relativeTime(c.sync.finishedAt)}` : 'Not synced yet'}</p>
          {c.sync.status === 'failed' && <p className="text-red-600">Last sync failed: {c.sync.error}</p>}
          {c.sync.status === 'queued' && c.sync.error && <p className="text-amber-700">{c.sync.error}</p>}
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Counter label="Campaigns" value={counts.campaigns} />
        <Counter label="Active campaigns" value={counts.activeCampaigns} />
        <Counter label="Ad sets" value={counts.adsets} />
        <Counter label="Ads" value={counts.ads} />
        <Counter label="Rejected ads" value={counts.rejectedAds} warn={counts.rejectedAds > 0} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ENTITY_PAGES.map((p) => (
          <Link key={p.slug} to={p.slug} className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 hover:bg-slate-50/60">
            <span className={cn('rounded-lg p-2', p.tone)}>
              <p.icon className="size-5" strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 font-medium text-ink">
                {p.title}
                {!p.kind && <Badge tone="gray">Next phase</Badge>}
              </span>
              <span className="block text-sm text-slate-500">{p.description}</span>
            </span>
            <ArrowRight className="mt-1 size-4 text-slate-300 group-hover:text-slate-500" />
          </Link>
        ))}
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 text-sm text-brand-900">
        <Sparkles className="mt-0.5 size-4 shrink-0" />
        <p>
          <strong className="font-medium">Lead Ads with AI follow-up is coming next.</strong> Every Instant Form lead will be cleaned up by AI (name, phone, language), spam-checked and scored, then followed up on WhatsApp in the lead's language.
        </p>
      </div>

      {picking && <AccountPicker current={c} onClose={() => setPicking(false)} />}
      {showLogs && <LogsDialog onClose={() => setShowLogs(false)} />}
      {confirmDisconnect && (
        <ConfirmDialog title="Disconnect Facebook?" confirmLabel="Disconnect" loading={action.isPending} onConfirm={() => action.mutate('disconnect')} onClose={() => setConfirmDisconnect(false)}>
          Zeta Connect stops reading and changing this ad account. Your ads keep running on Facebook, and synced data stays here until you reconnect.
        </ConfirmDialog>
      )}
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

function Counter({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', warn ? 'text-red-600' : 'text-ink')}>{value.toLocaleString('en-IN')}</p>
      <p className="text-[11px] text-slate-400">Synced locally</p>
    </Card>
  );
}

function AccountPicker({ current, onClose }: { current?: FbConnectionInfo; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [chosen, setChosen] = useState<string | null>(current?.adAccountId ?? null);
  const accounts = useQuery({ queryKey: ['fbads-accounts', workspace.id], queryFn: () => api.get<{ accounts: FbAdAccount[] }>(`/workspaces/${workspace.id}/facebook-ads/accounts`) });
  const pick = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/facebook-ads/account`, { adAccountId: chosen }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fbads', workspace.id] });
      toast.success('Ad account connected. Syncing your campaigns…');
      onClose();
    },
  });
  return (
    <Dialog
      icon={<Building2 className="size-5" strokeWidth={1.5} />}
      title="Choose an ad account"
      subtitle="Zeta Connect manages one ad account per workspace."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => pick.mutate()} loading={pick.isPending} disabled={!chosen || chosen === current?.adAccountId}>
            Use this account
          </Button>
        </>
      }
    >
      {pick.error != null && <div className="mb-3"><Alert>{errorMessage(pick.error)}</Alert></div>}
      {accounts.isPending ? (
        <Spinner />
      ) : accounts.error ? (
        <Alert>{errorMessage(accounts.error)}</Alert>
      ) : accounts.data.accounts.length === 0 ? (
        <p className="text-sm text-slate-600">This Facebook login has no ad accounts. Create one in Meta Business Settings, then try again.</p>
      ) : (
        <div className="space-y-1.5" role="radiogroup" aria-label="Ad accounts">
          {accounts.data.accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={chosen === a.id}
              onClick={() => setChosen(a.id)}
              className={cn('flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left', chosen === a.id ? 'border-brand-500 bg-brand-50/60' : 'border-slate-200 hover:border-slate-300')}
            >
              <span>
                <span className="block text-sm font-medium text-ink">{a.name}</span>
                <span className="block text-xs text-slate-500">
                  {a.id.replace('act_', '')} · {a.currency} · {a.timezone}
                </span>
              </span>
              {chosen === a.id ? <CheckCircle2 className="size-4 text-brand-600" /> : a.status !== 1 && <Badge tone="amber">{ACCOUNT_STATUS[a.status]?.label ?? 'Inactive'}</Badge>}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function LogsDialog({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const logs = useQuery({
    queryKey: ['fbads-logs', workspace.id],
    queryFn: () => api.get<{ logs: { id: string; endpoint: string; method: string; httpStatus: number | null; error: string | null; durationMs: number | null; at: string }[] }>(`/workspaces/${workspace.id}/facebook-ads/logs`),
  });
  return (
    <Dialog icon={<ScrollText className="size-5" strokeWidth={1.5} />} title="Facebook API logs" subtitle="The last 500 calls Zeta Connect made to Meta for this workspace." width="max-w-3xl" onClose={onClose}>
      {logs.isPending ? (
        <Spinner />
      ) : logs.error ? (
        <Alert>{errorMessage(logs.error)}</Alert>
      ) : !logs.data.logs.length ? (
        <p className="text-sm text-slate-500">No calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Call</th>
                <th className="py-1.5 pr-3 font-medium">Result</th>
                <th className="py-1.5 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {logs.data.logs.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-500">{formatDate(l.at, true)}</td>
                  <td className="py-1.5 pr-3 break-all text-slate-800">
                    {l.method} {l.endpoint}
                  </td>
                  <td className={cn('py-1.5 pr-3', l.error ? 'text-red-600' : 'text-brand-700')}>{l.error ? `${l.httpStatus ?? 'ERR'} ${l.error}` : l.httpStatus}</td>
                  <td className="py-1.5 text-right text-slate-500">{l.durationMs ?? '—'} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
