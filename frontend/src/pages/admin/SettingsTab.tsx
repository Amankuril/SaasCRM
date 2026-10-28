import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select, Spinner, errorMessage } from '../../components/ui';
import { api } from '../../lib/api';

interface PlatformSettings {
  announcement: { active: boolean; text: string; tone: 'info' | 'warning' | 'critical' };
  signupsEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

export function SettingsTab() {
  const queryClient = useQueryClient();
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

  return (
    <div className="space-y-4">
      {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved. Changes reach every business within a few seconds.</Alert>}

      <Card className="space-y-3 p-4 text-sm">
        <div>
          <h3 className="font-semibold text-ink">Announcement banner</h3>
          <p className="text-slate-500">Shown at the top of every business workspace (outages, Meta issues, new features).</p>
        </div>
        <Field label="Message" htmlFor="ps-text">
          <Input id="ps-text" maxLength={500} value={form.announcement.text} onChange={(e) => setForm({ ...form, announcement: { ...form.announcement, text: e.target.value } })} />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label="Style" htmlFor="ps-tone">
              <Select id="ps-tone" value={form.announcement.tone} onChange={(e) => setForm({ ...form, announcement: { ...form.announcement, tone: e.target.value as PlatformSettings['announcement']['tone'] } })}>
                <option value="info">Info (blue)</option>
                <option value="warning">Warning (amber)</option>
                <option value="critical">Critical (red)</option>
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" className="size-4 accent-emerald-600" checked={form.announcement.active} onChange={(e) => setForm({ ...form, announcement: { ...form.announcement, active: e.target.checked } })} />
            Show the banner
          </label>
          <Button className="ml-auto" loading={save.isPending} onClick={() => save.mutate({ announcement: form.announcement })}>Save banner</Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4 text-sm">
        <h3 className="font-semibold text-ink">Access switches</h3>
        <Toggle
          label="Allow new sign-ups"
          hint="Off: the sign-up page refuses new accounts. Invites to existing businesses still work."
          checked={form.signupsEnabled}
          onChange={(v) => save.mutate({ signupsEnabled: v })}
        />
        <Toggle
          label="Maintenance mode"
          hint="On: every business user is locked out (login and API) until you switch it off. Platform admins keep working."
          checked={form.maintenanceMode}
          danger
          onChange={(v) => (!v || window.confirm('Lock every business out of Zeta Connect now?')) && save.mutate({ maintenanceMode: v, maintenanceMessage: form.maintenanceMessage })}
        />
        <Field label="Maintenance message" htmlFor="ps-mm" hint="Shown to businesses while maintenance mode is on.">
          <div className="flex gap-2">
            <Input id="ps-mm" maxLength={300} placeholder="We're upgrading Zeta Connect. Back by 6 PM IST." value={form.maintenanceMessage} onChange={(e) => setForm({ ...form, maintenanceMessage: e.target.value })} />
            <Button variant="secondary" onClick={() => save.mutate({ maintenanceMessage: form.maintenanceMessage })}>Save</Button>
          </div>
        </Field>
      </Card>

      <Card className="space-y-3 p-4 text-sm">
        <h3 className="font-semibold text-ink">Recovery tools</h3>
        {requeue.error != null && <Alert>{errorMessage(requeue.error)}</Alert>}
        {requeue.data && <Alert tone="success">Re-queued {requeue.data.requeued} webhook event(s).</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-slate-600">Re-process Meta webhooks that failed or got stuck (missing messages / statuses after an outage). Safe to run more than once.</p>
          <Button variant="secondary" loading={requeue.isPending} onClick={() => requeue.mutate()}>Retry failed webhooks</Button>
        </div>
      </Card>
    </div>
  );
}

function Toggle({ label, hint, checked, danger, onChange }: { label: string; hint: string; checked: boolean; danger?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" className={`mt-0.5 size-4 ${danger ? 'accent-red-600' : 'accent-emerald-600'}`} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-slate-800">{label}</span>
        <span className="block text-slate-500">{hint}</span>
      </span>
    </label>
  );
}
