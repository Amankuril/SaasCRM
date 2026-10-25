import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CheckCheck, FlaskConical, MessageCircle, RefreshCw, Send, Unplug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { TemplatePreview } from '../components/TemplatePreview';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, errorMessage, fieldError } from '../components/ui';
import { ApiError, api, type ChatMessage, type ConnectionPayload, type MessageTemplate, type WhatsAppConnection } from '../lib/api';
import { SignupCancelled, launchEmbeddedSignup } from '../lib/facebook';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

export function WhatsAppPage() {
  const { workspace, can } = useWorkspace();
  // Result of a Facebook signup, kept here because the connect card unmounts once connected.
  const [signup, setSignup] = useState<{ pin: string | null; warning: string | null } | null>(null);
  const query = useQuery({
    queryKey: ['whatsapp', workspace.id],
    queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`),
  });

  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  const { connection, webhook, sandbox, embeddedSignup } = query.data;
  const writable = workspace.status !== 'suspended';

  return (
    <>
      <PageHeader title="WhatsApp" description="Your WhatsApp Business number, its health, and a test console." />
      {sandbox && (
        <div className="mb-6">
          <Alert tone="info">
            <strong>Sandbox mode.</strong> The server is using a simulated WhatsApp provider: any credentials work, no real messages are sent, and delivery
            receipts are faked. Set <code>WHATSAPP_PROVIDER=meta</code> to use the real Cloud API.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {signup && (
            <Alert tone={signup.warning ? 'error' : 'success'}>
              {signup.warning ? (
                <>WhatsApp is connected, but the number isn&apos;t registered yet. {signup.warning}</>
              ) : (
                <>
                  WhatsApp connected with Facebook.
                  {signup.pin && (
                    <>
                      {' '}
                      We set your number&apos;s two-step verification PIN to <strong className="font-mono">{signup.pin}</strong>. Save it: Meta asks for it if you ever move this
                      number to another app. It won&apos;t be shown again.
                    </>
                  )}
                </>
              )}
            </Alert>
          )}
          {connection ? (
            <ConnectionCard connection={connection} canManage={can('provider:manage') && writable} />
          ) : can('provider:manage') && writable ? (
            <ConnectCard sandbox={sandbox} embeddedSignup={embeddedSignup} onSignedUp={setSignup} />
          ) : (
            <Card className="p-5">
              <EmptyState icon={<MessageCircle className="size-5" />} title="No WhatsApp number connected">
                Ask the workspace owner to connect the business&apos;s WhatsApp number.
              </EmptyState>
            </Card>
          )}
          {connection && can('messages:send') && writable && <SendTestCard />}
        </div>

        <div className="space-y-6 lg:col-span-2">
          {connection && !sandbox && !connection.lastWebhookAt && (
            <Alert tone="info">
              <strong>No messages received from Meta yet.</strong> Sending works, but customer replies and delivery ticks only arrive once Meta can reach this server:
              your tunnel (e.g. ngrok) must be running, and the callback URL and verify token below must be saved in the Meta app (WhatsApp → Configuration) with the
              <code className="mx-1">messages</code> field subscribed.
            </Alert>
          )}
          {can('provider:manage') && <WebhookCard webhook={webhook} />}
          {connection && sandbox && can('provider:manage') && writable && <SimulateInboundCard />}
        </div>
      </div>

      {connection && (
        <div className="mt-6">
          <MessageLog />
        </div>
      )}
    </>
  );
}

function ConnectCard({
  sandbox,
  embeddedSignup,
  onSignedUp,
}: {
  sandbox: boolean;
  embeddedSignup: ConnectionPayload['embeddedSignup'];
  onSignedUp: (result: { pin: string | null; warning: string | null }) => void;
}) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [showManual, setShowManual] = useState(!embeddedSignup.enabled);
  const facebook = useMutation({
    mutationFn: async () => {
      if (!embeddedSignup.enabled) throw new Error('Facebook signup is not set up.');
      const result = await launchEmbeddedSignup({ appId: embeddedSignup.appId, configId: embeddedSignup.configId, version: embeddedSignup.graphVersion });
      // The code expires ~30 seconds after the popup closes: send it straight away.
      return api.post<{ pin: string | null; warning: string | null }>(`/workspaces/${workspace.id}/whatsapp/connection/embedded-signup`, result);
    },
    onSuccess: (res) => {
      onSignedUp({ pin: res.pin, warning: res.warning });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] });
    },
  });
  const facebookError = facebook.error instanceof SignupCancelled ? null : facebook.error;
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '' });
  const connect = useMutation({
    mutationFn: () => api.put(`/workspaces/${workspace.id}/whatsapp/connection`, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] });
    },
  });
  const err = connect.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    connect.mutate();
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">Connect your WhatsApp Business number</h2>

      {embeddedSignup.enabled ? (
        <div className="mt-4 rounded-xl border border-slate-200 p-5 text-center">
          <p className="text-sm text-slate-600">Log in with Facebook, pick or create your WhatsApp Business account, and add your number. We do the rest.</p>
          <Button className="mt-4 bg-[#1877F2] hover:bg-[#166FE5]" loading={facebook.isPending} onClick={() => facebook.mutate()}>
            <FacebookIcon /> Connect WhatsApp with Facebook
          </Button>
          {facebook.isPending && <p className="mt-2 text-xs text-slate-500">Finish the steps in the Facebook window…</p>}
          {facebookError != null && (
            <div className="mt-3 text-left">
              <Alert>{facebookError instanceof Error && !(facebookError instanceof ApiError) ? facebookError.message : errorMessage(facebookError)}</Alert>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-sm text-slate-500">
          {sandbox ? 'Sandbox mode: any IDs and token work.' : 'Connect with the IDs and a permanent access token from your Meta developer app.'}
        </p>
      )}

      {embeddedSignup.enabled && (
        <div className="my-5 flex items-center gap-3 text-xs font-medium text-slate-400 uppercase">
          <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
        </div>
      )}
      {embeddedSignup.enabled && !showManual ? (
        <button type="button" onClick={() => setShowManual(true)} className="text-sm font-medium text-brand-700 hover:underline">
          Connect manually with IDs and an access token
        </button>
      ) : (
        <>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>
              Open <span className="font-medium">developers.facebook.com → your app → WhatsApp → API Setup</span>.
            </li>
            <li>Copy the Phone number ID and the WhatsApp Business Account ID.</li>
            <li>Generate an access token (a System User token for anything long-lived) and paste it below.</li>
          </ol>

          <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
            {err != null && !isFieldError && <Alert>{errorMessage(err)}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="WhatsApp Business Account ID" htmlFor="waba" error={fieldError(err, 'wabaId')}>
                <Input id="waba" inputMode="numeric" value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} placeholder={sandbox ? 'e.g. 102290129340398' : ''} />
              </Field>
              <Field label="Phone number ID" htmlFor="phone-id" error={fieldError(err, 'phoneNumberId')}>
                <Input id="phone-id" inputMode="numeric" value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} placeholder={sandbox ? 'e.g. 106540352242922' : ''} />
              </Field>
            </div>
            <Field label="Access token" htmlFor="token" error={fieldError(err, 'accessToken')} hint="Stored encrypted. It is never shown again.">
              <Input id="token" type="password" autoComplete="off" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} />
            </Field>
            <Button type="submit" loading={connect.isPending}>
              Verify and connect
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07Z" />
    </svg>
  );
}

/** Numbers added through Facebook signup must be registered for Cloud API (two-step PIN). */
function RegisterNumber() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState('');
  const register = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/whatsapp/connection/register`, { pin }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['whatsapp', workspace.id] }),
  });
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-900">Register this number to send and receive messages</p>
      <p className="mt-0.5 text-xs text-amber-800">
        Enter a 6-digit PIN. If the number already has two-step verification (Meta Business Settings → WhatsApp accounts → Phone numbers), use that PIN; otherwise this
        becomes its new PIN.
      </p>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
      >
        <div className="w-32">
          <Input aria-label="Two-step verification PIN" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
        </div>
        <Button type="submit" loading={register.isPending} disabled={pin.length !== 6}>
          Register number
        </Button>
      </form>
      {register.error != null && <p className="mt-2 text-xs text-red-700">{errorMessage(register.error)}</p>}
    </div>
  );
}

const QUALITY_TONE: Record<string, 'green' | 'amber' | 'red'> = { GREEN: 'green', YELLOW: 'amber', RED: 'red' };

function ConnectionCard({ connection, canManage }: { connection: WhatsAppConnection; canManage: boolean }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['whatsapp', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] });
  };
  const refresh = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/whatsapp/connection/refresh`), onSuccess: invalidate });
  const disconnect = useMutation({ mutationFn: () => api.delete(`/workspaces/${workspace.id}/whatsapp/connection`), onSuccess: invalidate });
  const error = refresh.error ?? disconnect.error;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-brand-50 p-2.5 text-brand-700">
            <MessageCircle className="size-5" />
          </div>
          <div>
            <p className="font-semibold text-ink">{connection.displayPhoneNumber ?? connection.phoneNumberId}</p>
            <p className="text-sm text-slate-500">{connection.verifiedName}</p>
          </div>
        </div>
        {connection.status === 'connected' ? <Badge tone="green">Connected</Badge> : <Badge tone="red">Needs attention</Badge>}
      </div>

      {canManage && connection.connectedVia === 'embedded_signup' && !connection.registered && <RegisterNumber />}
      {connection.status === 'error' && (
        <div className="mt-4">
          <Alert>
            WhatsApp rejected the saved credentials{connection.lastError ? `: ${connection.lastError}` : '.'} Sending is paused. Disconnect and connect again with a valid
            token.
          </Alert>
        </div>
      )}
      {error != null && (
        <div className="mt-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Stat label="Quality rating">
          {connection.qualityRating ? <Badge tone={QUALITY_TONE[connection.qualityRating] ?? 'gray'}>{connection.qualityRating}</Badge> : '—'}
        </Stat>
        <Stat label="Messaging limit">{connection.messagingLimitTier?.replace('TIER_', '') ?? '—'}</Stat>
        <Stat label="Last webhook">{connection.lastWebhookAt ? formatDate(connection.lastWebhookAt, true) : 'None yet'}</Stat>
        <Stat label="Checked">{connection.lastSyncAt ? formatDate(connection.lastSyncAt, true) : '—'}</Stat>
      </dl>
      <p className="mt-3 text-xs text-slate-400">
        Phone number ID {connection.phoneNumberId} · WABA {connection.wabaId} · {connection.connectedVia === 'embedded_signup' ? 'connected with Facebook' : 'connected manually'}
      </p>

      {canManage && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className="size-4" /> Refresh health
          </Button>
          <Button
            variant="danger"
            loading={disconnect.isPending}
            onClick={() => {
              if (window.confirm('Disconnect this WhatsApp number? Sending stops until you connect again. Message history is kept.')) disconnect.mutate();
            }}
          >
            <Unplug className="size-4" /> Disconnect
          </Button>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-800">{children}</dd>
    </div>
  );
}

function WebhookCard({ webhook }: { webhook: ConnectionPayload['webhook'] }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Webhook (platform setting)</h2>
        {webhook.configured ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not configured</Badge>}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Set once in the Meta app (WhatsApp → Configuration) for all workspaces. Subscribe to the <code>messages</code> and{' '}
        <code>message_template_status_update</code> fields.
      </p>
      <div className="mt-4">
        <Field label="Callback URL" htmlFor="callback">
          <Input id="callback" readOnly value={webhook.callbackUrl} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
        </Field>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Verify token and app secret come from the server&apos;s <code>META_WEBHOOK_VERIFY_TOKEN</code> and <code>META_APP_SECRET</code>. In local development, expose
        the API with a tunnel (ngrok / cloudflared) and set <code>PUBLIC_API_URL</code>.
      </p>
    </Card>
  );
}

function SendTestCard() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'template' | 'text'>('template');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [bodyParams, setBodyParams] = useState<string[]>([]);
  const [sent, setSent] = useState(false);

  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
  });
  const template = templates.data?.templates.find((t) => t.id === templateId);

  const send = useMutation({
    mutationFn: () =>
      api.post(
        `/workspaces/${workspace.id}/messages`,
        mode === 'text' ? { type: 'text', to, text } : { type: 'template', to, templateId, headerParams, bodyParams },
      ),
    onSuccess: () => {
      setSent(true);
      void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id] });
    },
  });
  const err = send.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = templates.data?.templates.find((x) => x.id === id);
    setHeaderParams(Array(t?.variables.header ?? 0).fill(''));
    setBodyParams(Array(t?.variables.body ?? 0).fill(''));
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Send className="size-4" /> Send a test message
      </h2>
      <form
        className="mt-4 space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSent(false);
          send.mutate();
        }}
      >
        {err != null && !isFieldError && <Alert>{errorMessage(err)}</Alert>}
        {sent && <Alert tone="success">Queued. Watch its status update in the message log below.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Recipient phone" htmlFor="to" error={fieldError(err, 'to')} hint="With country code, e.g. +91 98765 43210">
            <Input id="to" type="tel" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Message type" htmlFor="mode">
            <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as 'template' | 'text')}>
              <option value="template">Approved template</option>
              <option value="text">Free text (24h window only)</option>
            </Select>
          </Field>
        </div>

        {mode === 'text' ? (
          <Field label="Message" htmlFor="text" error={fieldError(err, 'text')} hint="Only works if this customer messaged you in the last 24 hours.">
            <textarea
              id="text"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
            />
          </Field>
        ) : templates.data?.templates.length === 0 ? (
          <Alert tone="info">No approved templates yet. Sync or create one on the Templates page.</Alert>
        ) : (
          <>
            <Field label="Template" htmlFor="tpl" error={fieldError(err, 'templateId')}>
              <Select id="tpl" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                <option value="">Choose an approved template</option>
                {templates.data?.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
            </Field>
            {template && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  {headerParams.map((v, i) => (
                    <Field key={`h${i}`} label={`Header {{${i + 1}}}`} htmlFor={`h${i}`} error={i === 0 ? fieldError(err, 'headerParams') : undefined}>
                      <Input id={`h${i}`} value={v} onChange={(e) => setHeaderParams(headerParams.map((x, j) => (j === i ? e.target.value : x)))} />
                    </Field>
                  ))}
                  {bodyParams.map((v, i) => (
                    <Field key={`b${i}`} label={`Body {{${i + 1}}}`} htmlFor={`b${i}`} error={i === 0 ? fieldError(err, 'bodyParams') : undefined}>
                      <Input id={`b${i}`} value={v} onChange={(e) => setBodyParams(bodyParams.map((x, j) => (j === i ? e.target.value : x)))} />
                    </Field>
                  ))}
                  {headerParams.length + bodyParams.length === 0 && <p className="text-sm text-slate-500">This template has no variables.</p>}
                </div>
                <TemplatePreview components={template.components} headerParams={headerParams} bodyParams={bodyParams} />
              </div>
            )}
          </>
        )}

        <Button type="submit" loading={send.isPending} disabled={mode === 'template' && !templateId}>
          Send
        </Button>
      </form>
    </Card>
  );
}

function SimulateInboundCard() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('+91 98111 12222');
  const [text, setText] = useState('Hi, I would like to book an appointment');
  const simulate = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/whatsapp/simulate-inbound`, { from, text, profileName: 'Test Customer' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id] }),
  });

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <FlaskConical className="size-4" /> Simulate a customer message
      </h2>
      <p className="mt-1 text-sm text-slate-500">Development only. Opens the 24-hour window for this number so you can test free-text replies.</p>
      <div className="mt-4 space-y-3">
        {simulate.error != null && <Alert>{errorMessage(simulate.error)}</Alert>}
        <Field label="Customer phone" htmlFor="sim-from">
          <Input id="sim-from" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor="sim-text">
          <Input id="sim-text" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Button variant="secondary" loading={simulate.isPending} onClick={() => simulate.mutate()}>
          Receive message
        </Button>
      </div>
    </Card>
  );
}

const STATUS_TONE = { queued: 'gray', submitted: 'gray', sent: 'blue', delivered: 'blue', read: 'green', failed: 'red', received: 'green' } as const;
const PENDING_STATUSES = new Set(['queued', 'submitted', 'sent', 'delivered']);

function MessageLog() {
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['messages', workspace.id],
    queryFn: () => api.get<{ messages: ChatMessage[] }>(`/workspaces/${workspace.id}/messages?limit=25`),
    // Poll while receipts may still arrive (realtime updates come with the inbox in Phase 3).
    refetchInterval: (q) => (q.state.data?.messages.some((m) => PENDING_STATUSES.has(m.status)) ? 2_000 : 10_000),
  });

  return (
    <Card>
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Recent messages</h2>
      </div>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <div className="p-5">
          <Alert>{errorMessage(query.error)}</Alert>
        </div>
      ) : query.data.messages.length === 0 ? (
        <EmptyState icon={<MessageCircle className="size-5" />} title="No messages yet">
          Send a test message or wait for a customer to write in.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {query.data.messages.map((m) => (
            <li key={m.id} className="flex items-start gap-3 px-5 py-3 text-sm">
              <span className={m.direction === 'inbound' ? 'mt-0.5 text-emerald-600' : 'mt-0.5 text-sky-600'} title={m.direction}>
                {m.direction === 'inbound' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">
                  {m.contact?.name ?? m.contact?.phone}{' '}
                  {m.contact?.name && <span className="font-normal text-slate-400">{m.contact.phone}</span>}
                </p>
                <p className="truncate text-slate-600">{summary(m)}</p>
                {m.error && <p className="mt-0.5 text-xs text-red-600">{m.error.title}: {m.error.message}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={STATUS_TONE[m.status]}>
                  {m.status === 'read' && <CheckCheck className="mr-1 size-3" />}
                  {m.status}
                </Badge>
                <time className="text-xs text-slate-400">{formatDate(m.createdAt, true)}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function summary(m: ChatMessage): string {
  const c = m.content as { text?: string; preview?: string; template?: { name: string }; caption?: string; title?: string };
  if (m.type === 'template') return `Template ${c.template?.name}: ${c.preview ?? ''}`;
  return c.text ?? c.caption ?? c.title ?? `[${m.type}]`;
}
