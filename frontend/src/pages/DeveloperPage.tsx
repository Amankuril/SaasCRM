import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, ChevronDown, ChevronRight, Copy, KeyRound, Pause, Play, Plus, RefreshCw, RotateCcw, Send, Trash2, Webhook } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Modal } from '../components/crm';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../components/ui';
import { ApiError, api, type ApiKeyInfo, type DeveloperCatalog, type WebhookDeliveryInfo, type WebhookInfo } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

type Tab = 'keys' | 'webhooks' | 'reference';

export function DeveloperPage() {
  const { workspace, can } = useWorkspace();
  const [tab, setTab] = useState<Tab>('keys');
  const catalog = useQuery({
    queryKey: ['developer-catalog', workspace.id],
    queryFn: () => api.get<DeveloperCatalog>(`/workspaces/${workspace.id}/developer/catalog`),
    enabled: can('developer:manage'),
    staleTime: Infinity,
  });

  if (!can('developer:manage')) return <Alert tone="info">Only owners and admins can manage API keys and webhooks.</Alert>;
  if (catalog.isPending) return <Spinner />;
  if (catalog.error) return <Alert>{errorMessage(catalog.error)}</Alert>;

  return (
    <>
      <PageHeader
        title="Developers"
        description="Connect Zeta Connect to your CRM, store or automation tools (Zapier, Make, Pabbly) with the REST API and webhooks."
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {(
          [
            ['keys', 'API keys', KeyRound],
            ['webhooks', 'Webhooks', Webhook],
            ['reference', 'API reference', BookOpen],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
      {tab === 'keys' && <KeysTab catalog={catalog.data} />}
      {tab === 'webhooks' && <WebhooksTab catalog={catalog.data} />}
      {tab === 'reference' && <ReferenceTab catalog={catalog.data} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const KEY_STATE = { active: 'green', revoked: 'gray', expired: 'amber' } as const;

function KeysTab({ catalog }: { catalog: DeveloperCatalog }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = workspace.status !== 'suspended';
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; secret: string; note?: string } | null>(null);
  const list = useQuery({ queryKey: ['api-keys', workspace.id], queryFn: () => api.get<{ apiKeys: ApiKeyInfo[] }>(`/workspaces/${workspace.id}/developer/api-keys`) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['api-keys', workspace.id] });

  const roll = useMutation({
    mutationFn: (id: string) => api.post<{ key: string }>(`/workspaces/${workspace.id}/developer/api-keys/${id}/roll`),
    onSuccess: ({ key }) => {
      refresh();
      setRevealed({ title: 'New API key', secret: key, note: 'The old key keeps working for 24 hours so you can switch your integration over.' });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/developer/api-keys/${id}`), onSuccess: refresh });
  const actionError = roll.error ?? revoke.error;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">Keys act for this workspace with only the scopes you pick. Keep them on your server, never in a website or app.</p>
        {editable && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New API key
          </Button>
        )}
      </div>
      {actionError != null && <Alert>{errorMessage(actionError)}</Alert>}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.apiKeys.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No API keys yet">
            Create a key to add contacts, send templates or start flows from your own systems.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.apiKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{k.name}</span>
                    <Badge tone={KEY_STATE[k.state]}>{k.state}</Badge>
                    {k.rolled && k.state === 'active' && <Badge tone="amber">rolled · expires {formatDate(k.expiresAt!, true)}</Badge>}
                  </div>
                  <p className="font-mono text-xs break-all text-slate-500">{k.hint}</p>
                  <div className="flex flex-wrap gap-1">
                    {k.scopes.length ? k.scopes.map((s) => <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{s}</span>) : <span className="text-xs text-slate-400">no scopes</span>}
                  </div>
                  <p className="text-xs text-slate-400">
                    Created {formatDate(k.createdAt)} · {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt, true)}` : 'never used'}
                    {k.expiresAt && !k.rolled && ` · expires ${formatDate(k.expiresAt)}`}
                  </p>
                </div>
                {editable && k.state === 'active' && (
                  <div className="flex shrink-0 gap-2">
                    {!k.rolled && (
                      <Button variant="secondary" loading={roll.isPending && roll.variables === k.id} onClick={() => window.confirm(`Roll "${k.name}"? You get a new key; the old one stops working in 24 hours.`) && roll.mutate(k.id)}>
                        <RotateCcw className="size-4" /> Roll
                      </Button>
                    )}
                    <Button variant="danger" onClick={() => window.confirm(`Revoke "${k.name}"? Integrations using it stop working immediately.`) && revoke.mutate(k.id)}>
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && (
        <CreateKeyModal
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            refresh();
            setRevealed({ title: 'Your new API key', secret: key });
          }}
        />
      )}
      {revealed && <SecretModal {...revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function CreateKeyModal({ catalog, onClose, onCreated }: { catalog: DeveloperCatalog; onClose: () => void; onCreated: (key: string) => void }) {
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['contacts:read', 'contacts:write', 'messages:send']);
  const [expires, setExpires] = useState('never');
  const create = useMutation({
    mutationFn: () => api.post<{ key: string }>(`/workspaces/${workspace.id}/developer/api-keys`, { name, scopes, expiresInDays: expires === 'never' ? null : Number(expires) }),
    onSuccess: ({ key }) => onCreated(key),
  });
  const err = create.error;

  return (
    <Modal title="New API key" onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="key-name" error={fieldError(err, 'name')} hint="Where it's used, e.g. Zapier or Shopify sync.">
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Expires" htmlFor="key-exp">
            <Select id="key-exp" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="never">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
            </Select>
          </Field>
        </div>
        <CheckboxGrid label="Scopes" items={catalog.scopes} selected={scopes} onChange={setScopes} error={fieldError(err, 'scopes')} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create key
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const ENDPOINT_STATUS = { active: 'green', paused: 'gray', disabled: 'red' } as const;
const DELIVERY_STATUS = { pending: 'gray', retrying: 'amber', succeeded: 'green', dead: 'red' } as const;

function WebhooksTab({ catalog }: { catalog: DeveloperCatalog }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = workspace.status !== 'suspended';
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ title: string; secret: string; note?: string } | null>(null);
  const list = useQuery({ queryKey: ['webhooks', workspace.id], queryFn: () => api.get<{ webhooks: WebhookInfo[] }>(`/workspaces/${workspace.id}/developer/webhooks`) });
  const open = list.data?.webhooks.find((w) => w.id === openId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">We POST signed JSON to your URL when things happen. Failed deliveries are retried for about 11 hours.</p>
        {editable && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Add endpoint
          </Button>
        )}
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.webhooks.length === 0 ? (
          <EmptyState icon={<Webhook className="size-5" />} title="No webhook endpoints">
            Add a URL (for example a Zapier "Catch Hook") to get new messages, contacts and form submissions in real time.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.webhooks.map((w) => (
              <li key={w.id}>
                <button onClick={() => setOpenId(w.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-slate-800">{w.url}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {w.description ? `${w.description} · ` : ''}
                      {w.events.length} event(s)
                      {w.lastDeliveryAt && ` · last delivery ${formatDate(w.lastDeliveryAt, true)} (${w.lastDeliveryStatus})`}
                    </p>
                  </div>
                  <Badge tone={ENDPOINT_STATUS[w.status]}>{w.status}</Badge>
                  <ChevronRight className="size-4 text-slate-400" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && (
        <EndpointModal
          catalog={catalog}
          onClose={() => setCreating(false)}
          onSaved={(secret) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['webhooks', workspace.id] });
            if (secret) setRevealed({ title: 'Signing secret', secret, note: 'Use it to verify the Zeta-Signature header on every delivery.' });
          }}
        />
      )}
      {open && <EndpointDetail endpoint={open} catalog={catalog} editable={editable} onClose={() => setOpenId(null)} onSecret={(secret) => setRevealed({ title: 'New signing secret', secret, note: 'Deliveries are signed with both the old and the new secret for 24 hours.' })} />}
      {revealed && <SecretModal {...revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function EndpointModal({ catalog, endpoint, onClose, onSaved }: { catalog: DeveloperCatalog; endpoint?: WebhookInfo; onClose: () => void; onSaved: (secret: string | null) => void }) {
  const { workspace } = useWorkspace();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [events, setEvents] = useState<string[]>(endpoint?.events ?? ['message.received', 'contact.created', 'form.submitted']);
  const save = useMutation({
    mutationFn: () =>
      endpoint
        ? api.patch<{ webhook: WebhookInfo }>(`/workspaces/${workspace.id}/developer/webhooks/${endpoint.id}`, { url, description, events }).then(() => null)
        : api.post<{ secret: string }>(`/workspaces/${workspace.id}/developer/webhooks`, { url, description, events }).then((r) => r.secret),
    onSuccess: onSaved,
  });
  const err = save.error;

  return (
    <Modal title={endpoint ? 'Edit endpoint' : 'Add webhook endpoint'} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
        <Field label="Endpoint URL" htmlFor="wh-url" error={fieldError(err, 'url')} hint="Public https:// URL that answers 2xx within 10 seconds.">
          <Input id="wh-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" autoFocus />
        </Field>
        <Field label="Description (optional)" htmlFor="wh-desc">
          <Input id="wh-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Zapier → Google Sheets" />
        </Field>
        <CheckboxGrid label="Events" items={catalog.events} selected={events} onChange={setEvents} error={fieldError(err, 'events')} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {endpoint ? 'Save' : 'Add endpoint'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EndpointDetail({ endpoint, catalog, editable, onClose, onSecret }: { endpoint: WebhookInfo; catalog: DeveloperCatalog; editable: boolean; onClose: () => void; onSecret: (s: string) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState('');
  const base = `/workspaces/${workspace.id}/developer/webhooks/${endpoint.id}`;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['webhooks', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', endpoint.id] });
  };
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', endpoint.id, filter],
    queryFn: () => api.get<{ deliveries: WebhookDeliveryInfo[]; nextCursor: string | null }>(`${base}/deliveries${filter ? `?status=${filter}` : ''}`),
  });
  const setStatus = useMutation({ mutationFn: (status: 'active' | 'paused') => api.patch(base, { status }), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api.post<{ delivery: WebhookDeliveryInfo }>(`${base}/test`), onSuccess: refresh });
  const rotate = useMutation({
    mutationFn: () => api.post<{ secret: string }>(`${base}/rotate-secret`),
    onSuccess: ({ secret }) => {
      refresh();
      onSecret(secret);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(base),
    onSuccess: () => {
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['webhooks', workspace.id] });
    },
  });
  const actionError = setStatus.error ?? test.error ?? rotate.error ?? remove.error;
  const testResult = test.data?.delivery;

  if (editing) {
    return (
      <EndpointModal
        catalog={catalog}
        endpoint={endpoint}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          refresh();
        }}
      />
    );
  }

  return (
    <Modal title="Webhook endpoint" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ENDPOINT_STATUS[endpoint.status]}>{endpoint.status}</Badge>
            {endpoint.secretRotating && <Badge tone="amber">secret rotating</Badge>}
            {endpoint.consecutiveFailures > 0 && <span className="text-xs text-red-600">{endpoint.consecutiveFailures} failed attempt(s) in a row</span>}
          </div>
          <p className="font-mono text-xs break-all text-slate-700">{endpoint.url}</p>
          {endpoint.disabledReason && <p className="text-xs text-red-600">{endpoint.disabledReason}</p>}
          <div className="flex flex-wrap gap-1 pt-1">
            {endpoint.events.map((e) => (
              <span key={e} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                {e}
              </span>
            ))}
          </div>
        </div>

        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>
              <Send className="size-4" /> Send test
            </Button>
            {endpoint.status === 'active' ? (
              <Button variant="secondary" loading={setStatus.isPending} onClick={() => setStatus.mutate('paused')}>
                <Pause className="size-4" /> Pause
              </Button>
            ) : (
              <Button variant="secondary" loading={setStatus.isPending} onClick={() => setStatus.mutate('active')}>
                <Play className="size-4" /> {endpoint.status === 'disabled' ? 'Re-enable' : 'Resume'}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="secondary" loading={rotate.isPending} onClick={() => window.confirm('Create a new signing secret? The old one keeps working for 24 hours.') && rotate.mutate()}>
              <RotateCcw className="size-4" /> Rotate secret
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm('Delete this endpoint and its delivery log?') && remove.mutate()}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </div>
        )}
        {actionError != null && <Alert>{errorMessage(actionError)}</Alert>}
        {testResult && (
          <Alert tone={testResult.status === 'succeeded' ? 'success' : 'error'}>
            Test {testResult.status === 'succeeded' ? 'delivered' : 'failed'}: {testResult.attempts[0]?.error ?? `HTTP ${testResult.attempts[0]?.statusCode}`} in {testResult.attempts[0]?.durationMs} ms.
          </Alert>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Deliveries</h3>
            <div className="flex items-center gap-2">
              <Select aria-label="Filter deliveries" value={filter} onChange={(e) => setFilter(e.target.value)} className="py-1 text-xs">
                <option value="">All</option>
                <option value="succeeded">Succeeded</option>
                <option value="retrying">Retrying</option>
                <option value="dead">Failed</option>
              </Select>
              <button onClick={() => void deliveries.refetch()} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Refresh deliveries">
                <RefreshCw className="size-4" />
              </button>
            </div>
          </div>
          <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-slate-200">
            {deliveries.isPending ? (
              <Spinner />
            ) : deliveries.error ? (
              <div className="p-3">
                <Alert>{errorMessage(deliveries.error)}</Alert>
              </div>
            ) : deliveries.data.deliveries.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-500">No deliveries yet. Send a test event.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {deliveries.data.deliveries.map((d) => (
                  <DeliveryRow key={d.id} delivery={d} redeliverUrl={editable ? `${base}/deliveries/${d.id}/redeliver` : null} onDone={refresh} />
                ))}
              </ul>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">Personal data (phones, messages, form answers) is masked in this log. Logs are kept for 30 days.</p>
        </div>
      </div>
    </Modal>
  );
}

function DeliveryRow({ delivery: d, redeliverUrl, onDone }: { delivery: WebhookDeliveryInfo; redeliverUrl: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const redo = useMutation({ mutationFn: () => api.post(redeliverUrl!), onSuccess: onDone });
  const last = d.attempts.at(-1);
  return (
    <li className="text-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
        {open ? <ChevronDown className="size-3.5 text-slate-400" /> : <ChevronRight className="size-3.5 text-slate-400" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{d.eventType}</span>
        <span className="hidden text-xs text-slate-400 sm:inline">{formatDate(d.createdAt, true)}</span>
        <span className="w-14 text-right text-xs text-slate-500">{last?.statusCode ?? '—'}</span>
        <Badge tone={DELIVERY_STATUS[d.status]}>{d.status === 'dead' ? 'failed' : d.status}</Badge>
      </button>
      {open && (
        <div className="space-y-2 bg-slate-50 px-3 py-2 text-xs">
          <p className="font-mono text-slate-500">{d.eventId}</p>
          <ul className="space-y-0.5">
            {d.attempts.map((a, i) => (
              <li key={i} className="text-slate-600">
                #{i + 1} · {formatDate(a.at, true)} · {a.error ?? `HTTP ${a.statusCode}`} · {a.durationMs} ms
              </li>
            ))}
          </ul>
          {d.nextAttemptAt && <p className="text-amber-700">Next retry {formatDate(d.nextAttemptAt, true)}</p>}
          <pre className="max-h-48 overflow-auto rounded bg-white p-2 text-[11px] text-slate-700 ring-1 ring-slate-200">{JSON.stringify(d.payload, null, 2)}</pre>
          {redeliverUrl && (
            <Button variant="secondary" className="py-1 text-xs" loading={redo.isPending} onClick={() => redo.mutate()}>
              <RefreshCw className="size-3.5" /> Resend
            </Button>
          )}
          {redo.error != null && <p className="text-red-600">{errorMessage(redo.error)}</p>}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

function ReferenceTab({ catalog }: { catalog: DeveloperCatalog }) {
  const baseUrl = `${window.location.origin}/api/v1`;
  const examples: { title: string; code: string }[] = [
    {
      title: 'Create or update a contact (by phone)',
      code: `curl -X POST ${baseUrl}/contacts \\
  -H "Authorization: Bearer $ZETA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: lead-1234" \\
  -d '{"phone": "+919812345678", "name": "Asha", "tags": ["website-lead"], "custom_fields": {"city": "Pune"}}'`,
    },
    {
      title: 'Send an approved template',
      code: `curl -X POST ${baseUrl}/messages \\
  -H "Authorization: Bearer $ZETA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+919812345678", "type": "template", "template": {"name": "order_update"}, "body_params": ["Asha", "#A12"]}'`,
    },
    {
      title: 'Start an "API" flow with variables',
      code: `curl -X POST ${baseUrl}/flows/FLOW_ID/runs \\
  -H "Authorization: Bearer $ZETA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "+919812345678", "variables": {"order_id": "A-1001"}}'`,
    },
    {
      title: 'Verify a webhook (Node.js)',
      code: `import crypto from 'node:crypto';

// rawBody: the exact bytes received; header: req.headers['zeta-signature']
function verify(rawBody, header, secret) {
  const parts = header.split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // reject replays
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => p.length === expected.length + 3 &&
      crypto.timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(expected)));
}`,
    },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card className="space-y-2 p-5 text-sm text-slate-600">
          <h2 className="text-sm font-semibold text-ink">Basics</h2>
          <p>
            Base URL <code className="rounded bg-slate-100 px-1 font-mono text-xs break-all">{baseUrl}</code> · version <code className="font-mono text-xs">{catalog.apiVersion}</code>
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Send the key as <code className="font-mono text-xs">Authorization: Bearer zc_live_…</code>. Never put it in a URL.
            </li>
            <li>
              Lists return <code className="font-mono text-xs">{'{ data, has_more, next_cursor }'}</code>; pass <code className="font-mono text-xs">?cursor=</code> for the next page.
            </li>
            <li>
              Add an <code className="font-mono text-xs">Idempotency-Key</code> header to writes; retries with the same key return the first result.
            </li>
            <li>
              Errors look like <code className="font-mono text-xs">{'{ error: { code, message, request_id } }'}</code>. Limit: 300 requests/minute per key.
            </li>
            <li>Webhooks may arrive more than once or out of order: de-duplicate by event_id.</li>
          </ul>
        </Card>
        {examples.map((ex) => (
          <Card key={ex.title} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
              <h3 className="text-sm font-medium text-slate-800">{ex.title}</h3>
              <CopyButton value={ex.code} />
            </div>
            <pre className="overflow-x-auto bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">{ex.code}</pre>
          </Card>
        ))}
      </div>
      <div className="space-y-4">
        <ListCard title="Endpoints">
          {[
            'GET /me',
            'GET|POST /contacts',
            'GET|PATCH /contacts/:id',
            'POST /contacts/:id/tags',
            'POST /messages',
            'GET /messages, /messages/:id',
            'GET /templates',
            'GET /conversations',
            'GET /campaigns, /campaigns/:id',
            'GET /flows',
            'POST /flows/:id/runs',
            'GET /forms, /forms/:id/submissions',
            'GET|POST|PATCH|DELETE /webhooks',
          ].map((e) => (
            <li key={e} className="font-mono text-xs text-slate-700">
              {e}
            </li>
          ))}
        </ListCard>
        <ListCard title="Webhook events">
          {catalog.events.map((e) => (
            <li key={e.id}>
              <p className="font-mono text-xs text-slate-700">{e.id}</p>
              <p className="text-xs text-slate-500">{e.description}</p>
            </li>
          ))}
        </ListCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function CheckboxGrid({ label, items, selected, onChange, error }: { label: string; items: { id: string; description: string }[]; selected: string[]; onChange: (v: string[]) => void; error?: string }) {
  const all = selected.length === items.length;
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between">
        <legend className="text-sm font-medium text-slate-700">{label}</legend>
        <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onChange(all ? [] : items.map((i) => i.id))}>
          {all ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <label key={item.id} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5 text-sm hover:bg-slate-50">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-emerald-600"
              checked={selected.includes(item.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, item.id] : selected.filter((s) => s !== item.id))}
            />
            <span className="min-w-0">
              <span className="block font-mono text-xs text-slate-800">{item.id}</span>
              <span className="block text-xs text-slate-500">{item.description}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </fieldset>
  );
}

function SecretModal({ title, secret, note, onClose }: { title: string; secret: string; note?: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="info">Copy it now. For your security it won't be shown again.</Alert>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <code className="min-w-0 flex-1 font-mono text-xs break-all text-slate-800">{secret}</code>
          <CopyButton value={secret} />
        </div>
        {note && <p className="text-xs text-slate-500">{note}</p>}
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="shrink-0 rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
      aria-label="Copy"
    >
      {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
    </button>
  );
}

function ListCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </Card>
  );
}
