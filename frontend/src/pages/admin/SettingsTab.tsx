import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { AButton, Panel, Switch, useConfirm } from '../../components/admin';
import { Alert, Field, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type ReminderOffer } from '../../lib/api';
import { money } from '../reminders/shared';

interface PlatformSettings {
  announcement: { active: boolean; text: string; tone: 'info' | 'warning' | 'critical' };
  signupsEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  dateReminders: ReminderOffer;
}

const TONES = [
  { value: 'info', label: 'Info', dot: 'bg-sky-500', banner: 'border-sky-200 bg-sky-50 text-sky-800' },
  { value: 'warning', label: 'Warning', dot: 'bg-amber-500', banner: 'border-amber-200 bg-amber-50 text-amber-800' },
  { value: 'critical', label: 'Critical', dot: 'bg-red-500', banner: 'border-red-200 bg-red-50 text-red-700' },
] as const;

export function SettingsTab() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const query = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<{ settings: PlatformSettings }>('/admin/settings') });
  const [form, setForm] = useState<PlatformSettings | null>(null);
  useEffect(() => {
    if (query.data) setForm(query.data.settings);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: Partial<PlatformSettings>) => api.patch<{ settings: PlatformSettings }>('/admin/settings', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  });
  const requeue = useMutation({ mutationFn: () => api.post<{ requeued: number }>('/admin/ops/webhook-events/retry') });

  if (query.isPending || !form) return query.error ? <Alert>{errorMessage(query.error)}</Alert> : <Spinner />;
  const tone = TONES.find((t) => t.value === form.announcement.tone)!;

  return (
    <div className="space-y-5">
      {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved. Businesses see the change within a few seconds.</Alert>}

      <Panel
        title="Announcement banner"
        description="Shown at the top of every business workspace: outages, Meta issues, new features."
        actions={<Switch label="Show the banner" checked={form.announcement.active} onChange={(v) => setForm({ ...form, announcement: { ...form.announcement, active: v } })} />}
      >
        <div className="space-y-4 text-sm">
          <Field label="Message" htmlFor="ps-text">
            <Input id="ps-text" maxLength={500} placeholder="e.g. Meta is having delivery delays. Messages will go out as soon as it recovers." value={form.announcement.text} onChange={(e) => setForm({ ...form, announcement: { ...form.announcement, text: e.target.value } })} />
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Style</p>
            <div className="flex flex-wrap gap-2">
              {TONES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setForm({ ...form, announcement: { ...form.announcement, tone: t.value } })}
                  className={cn('inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium ring-1 transition', form.announcement.tone === t.value ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300')}
                >
                  <span className={cn('size-2 rounded-full', t.dot)} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-slate-400">Preview</p>
            <div className={cn('rounded-lg border px-4 py-2.5 text-sm', tone.banner, !form.announcement.active && 'opacity-50')}>{form.announcement.text || 'Your message appears here.'}</div>
            {!form.announcement.active && <p className="mt-1 text-xs text-slate-500">The banner is switched off and hidden from businesses.</p>}
          </div>
          <div className="flex justify-end">
            <AButton variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate({ announcement: form.announcement })}>
              Save banner
            </AButton>
          </div>
        </div>
      </Panel>

      <Panel title="Access" description="Platform-wide switches. They apply immediately.">
        <div className="-m-5 divide-y divide-slate-100 text-sm">
          <SettingRow title="Allow new sign-ups" text="Off: the sign-up page refuses new accounts. Invites to existing businesses still work.">
            <Switch label="Allow new sign-ups" checked={form.signupsEnabled} disabled={save.isPending} onChange={(v) => save.mutate({ signupsEnabled: v })} />
          </SettingRow>
          <SettingRow title="Maintenance mode" text="On: every business user is locked out (login and API) until you switch it off. Platform admins keep working." danger={form.maintenanceMode}>
            <Switch
              label="Maintenance mode"
              tone="red"
              checked={form.maintenanceMode}
              disabled={save.isPending}
              onChange={async (v) => {
                if (v && (await confirm({ title: 'Turn on maintenance mode?', message: 'Every business is locked out of Zeta Connect right away, including people working in it now.', confirmLabel: 'Lock businesses out', tone: 'danger' })) === null) return;
                save.mutate({ maintenanceMode: v, maintenanceMessage: form.maintenanceMessage });
              }}
            />
          </SettingRow>
          <div className="px-5 py-4">
            <Field label="Maintenance message" htmlFor="ps-mm" hint="Shown to businesses while maintenance mode is on.">
              <div className="flex gap-2">
                <Input id="ps-mm" maxLength={300} placeholder="We're upgrading Zeta Connect. Back by 6 PM IST." value={form.maintenanceMessage} onChange={(e) => setForm({ ...form, maintenanceMessage: e.target.value })} />
                <AButton onClick={() => save.mutate({ maintenanceMessage: form.maintenanceMessage })}>Save</AButton>
              </div>
            </Field>
          </div>
        </div>
      </Panel>

      <ReminderPricing value={form.dateReminders} saving={save.isPending} onSave={(dateReminders) => save.mutate({ dateReminders } as Partial<PlatformSettings>)} />

      <Panel title="Recovery tools">
        {requeue.error != null && (
          <div className="mb-3">
            <Alert>{errorMessage(requeue.error)}</Alert>
          </div>
        )}
        {requeue.data && (
          <div className="mb-3">
            <Alert tone="success">Re-queued {requeue.data.requeued} webhook event(s).</Alert>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div>
            <p className="font-medium text-slate-800">Retry failed Meta webhooks</p>
            <p className="text-slate-500">Re-processes webhooks that failed or got stuck, e.g. missing messages or statuses after an outage. Safe to run more than once.</p>
          </div>
          <AButton icon={RotateCcw} loading={requeue.isPending} onClick={() => requeue.mutate()}>
            Retry now
          </AButton>
        </div>
      </Panel>
    </div>
  );
}

const rupees = (paise: number) => (paise ? String(paise / 100) : '');
const paise = (text: string) => Math.max(0, Math.round((Number(text.replace(/[^\d.]/g, '')) || 0) * 100));

/** The Date reminders module and its one-time unlock offer. Nothing about the price is fixed in the app. */
function ReminderPricing({ value, saving, onSave }: { value: ReminderOffer; saving: boolean; onSave: (v: Partial<ReminderOffer>) => void }) {
  const [v, setV] = useState(value);
  const [price, setPrice] = useState(rupees(value.price));
  const [compare, setCompare] = useState(rupees(value.comparePrice));
  const [benefits, setBenefits] = useState(value.benefits.join('\n'));
  const priceP = paise(price);
  const compareP = paise(compare);
  const discount = compareP > priceP && priceP > 0 ? Math.round(((compareP - priceP) / compareP) * 100) : 0;
  const invalid = v.paid && priceP < 100;
  return (
    <Panel title="Date reminders" description="The date-based automation module and its one-time unlock. Reminders a business already activated keep running if you start charging.">
      <div className="-mx-5 -mt-5 divide-y divide-slate-100 border-b border-slate-100 text-sm">
        <SettingRow title="Module available" text="Off: businesses cannot create or activate date reminders.">
          <Switch label="Module available" checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
        </SettingRow>
        <SettingRow title="Charge a one-time unlock" text="Off: free for every business. You can still grant it to one business from its page.">
          <Switch label="Charge a one-time unlock" checked={v.paid} onChange={(paid) => setV({ ...v, paid })} />
        </SettingRow>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Price (INR)" htmlFor="dr-price" error={invalid ? 'Set a price of at least 1.' : undefined}>
          <Input id="dr-price" inputMode="decimal" placeholder="1499" value={price} invalid={invalid} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Price before discount (INR)" htmlFor="dr-compare" hint="Shown crossed out. Leave empty for no discount.">
          <Input id="dr-compare" inputMode="decimal" placeholder="2499" value={compare} onChange={(e) => setCompare(e.target.value)} />
        </Field>
        <Field label="Panel title" htmlFor="dr-title">
          <Input id="dr-title" maxLength={60} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        </Field>
        <Field label="Button label" htmlFor="dr-button">
          <Input id="dr-button" maxLength={40} value={v.buttonLabel} onChange={(e) => setV({ ...v, buttonLabel: e.target.value })} />
        </Field>
        <Field label="Benefits, one per line" htmlFor="dr-benefits">
          <textarea id="dr-benefits" rows={4} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-600 focus:ring-3 focus:ring-brand-600/15 focus:outline-none" value={benefits} onChange={(e) => setBenefits(e.target.value)} />
        </Field>
        <Field label="One payment unlocks" htmlFor="dr-scope">
          <Select id="dr-scope" value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value as ReminderOffer['scope'] })}>
            <option value="owner">Every business of the owner</option>
            <option value="workspace">Only the business that pays</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500 tabular-nums">{v.paid ? `Businesses see ${money(priceP, 'INR')}${discount ? `, ${discount}% off ${money(compareP, 'INR')}` : ''}` : 'Businesses use it for free'}</p>
        <AButton
          variant="primary"
          icon={Save}
          loading={saving}
          disabled={invalid}
          onClick={() => onSave({ enabled: v.enabled, paid: v.paid, title: v.title, price: priceP, comparePrice: compareP, buttonLabel: v.buttonLabel, scope: v.scope, benefits: benefits.split('\n').map((b) => b.trim()).filter(Boolean).slice(0, 8) })}
        >
          Save
        </AButton>
      </div>
    </Panel>
  );
}

function SettingRow({ title, text, danger, children }: { title: string; text: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', danger && 'bg-red-50/50')}>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-800">{title}</p>
        <p className="text-slate-500">{text}</p>
      </div>
      {children}
    </div>
  );
}
