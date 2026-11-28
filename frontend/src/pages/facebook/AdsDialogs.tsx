import { useMutation, useQuery } from '@tanstack/react-query';
import { Boxes, Crosshair, UserRoundSearch } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/feedback';
import { Alert, Button, Field, Input, Select, Toggle, errorMessage, fieldError } from '../../components/ui';
import { api, type ContactList, type FbRow } from '../../lib/api';
import { useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Active rows of one kind, for pickers. */
export function useFbRows(kind: string, enabled = true) {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['fbads-list', workspace.id, kind, 'picker'],
    queryFn: async () => {
      const out: FbRow[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await api.get<{ rows: FbRow[]; pages: number }>(`/workspaces/${workspace.id}/facebook-ads/entities/${kind}?page=${page}`);
        out.push(...r.rows);
        if (page >= r.pages) break;
      }
      return out;
    },
    enabled,
  });
}

function Footer({ onClose, onSave, saving, disabled, label }: { onClose: () => void; onSave: () => void; saving: boolean; disabled?: boolean; label: string }) {
  return (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={onSave} loading={saving} disabled={disabled}>
        {label}
      </Button>
    </>
  );
}

export function NewAdDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const adsets = useFbRows('adset');
  const creatives = useFbRows('creative');
  const [form, setForm] = useState({ name: '', adsetId: '', creativeId: '', active: false });
  const save = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/facebook-ads/ads`, { name: form.name, adsetId: form.adsetId, creativeId: form.creativeId, status: form.active ? 'ACTIVE' : 'PAUSED' }),
    onSuccess: () => {
      onDone();
      toast.success('Ad created. Facebook reviews it before it runs.');
      onClose();
    },
  });
  return (
    <Dialog icon={<Boxes className="size-5" strokeWidth={1.5} />} title="New ad" subtitle="Attach a creative to an ad set." onClose={onClose} footer={<Footer onClose={onClose} onSave={() => save.mutate()} saving={save.isPending} disabled={!form.name.trim() || !form.adsetId || !form.creativeId} label="Create ad" />}>
      <div className="space-y-3">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <Field label="Name" htmlFor="ad-name" error={fieldError(save.error, 'name')}>
          <Input id="ad-name" autoFocus maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Ad set" htmlFor="ad-adset" error={fieldError(save.error, 'adsetId')}>
          <Select id="ad-adset" value={form.adsetId} onChange={(e) => setForm({ ...form, adsetId: e.target.value })}>
            <option value="">Choose…</option>
            {(adsets.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.campaign?.name ? `(${a.campaign.name})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Creative" htmlFor="ad-creative" error={fieldError(save.error, 'creativeId')}>
          <Select id="ad-creative" value={form.creativeId} onChange={(e) => setForm({ ...form, creativeId: e.target.value })}>
            <option value="">Choose…</option>
            {(creatives.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <span className="flex items-center gap-2 text-sm text-slate-700">
          <Toggle label="Start active" checked={form.active} onChange={(active) => setForm({ ...form, active })} /> Start active (otherwise paused)
        </span>
      </div>
    </Dialog>
  );
}

export function NewAudienceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const tags = useTags(workspace.id);
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`), select: (d) => d.lists });
  const audiences = useFbRows('audience');
  const [type, setType] = useState<'custom' | 'lookalike'>('custom');
  const [form, setForm] = useState({ name: '', from: 'all', tagId: '', listId: '', sourceAudienceId: '', country: 'IN', percent: 1 });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string; uploaded: number }>(
        `/workspaces/${workspace.id}/facebook-ads/audiences`,
        type === 'custom'
          ? { subtype: 'custom', name: form.name, tagId: form.from === 'tag' ? form.tagId || null : null, listId: form.from === 'list' ? form.listId || null : null }
          : { subtype: 'lookalike', name: form.name, sourceAudienceId: form.sourceAudienceId, country: form.country, percent: form.percent },
      ),
    onSuccess: (r) => {
      onDone();
      toast.success(type === 'custom' ? `Audience created with ${r.uploaded.toLocaleString('en-IN')} contacts. Facebook matches them over the next few hours.` : 'Lookalike audience created. Facebook needs a few hours to fill it.');
      onClose();
    },
  });
  return (
    <Dialog icon={<UserRoundSearch className="size-5" strokeWidth={1.5} />} title="New audience" subtitle="Retarget your contacts, or find people like them." onClose={onClose} footer={<Footer onClose={onClose} onSave={() => save.mutate()} saving={save.isPending} disabled={!form.name.trim() || (type === 'lookalike' && !form.sourceAudienceId)} label="Create audience" />}>
      <div className="space-y-3">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="Audience type">
          {(['custom', 'lookalike'] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} className={`flex-1 rounded-md px-3 py-1.5 font-medium ${type === t ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
              {t === 'custom' ? 'From your contacts' : 'Lookalike'}
            </button>
          ))}
        </div>
        <Field label="Name" htmlFor="aud-name">
          <Input id="aud-name" maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {type === 'custom' ? (
          <>
            <Field label="Which contacts" htmlFor="aud-from" error={fieldError(save.error, 'tagId')}>
              <Select id="aud-from" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
                <option value="all">All contacts</option>
                <option value="tag">Contacts with a tag</option>
                <option value="list">A contact list</option>
              </Select>
            </Field>
            {form.from === 'tag' && (
              <Select aria-label="Tag" value={form.tagId} onChange={(e) => setForm({ ...form, tagId: e.target.value })}>
                <option value="">Choose tag…</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
            {form.from === 'list' && (
              <Select aria-label="List" value={form.listId} onChange={(e) => setForm({ ...form, listId: e.target.value })}>
                <option value="">Choose list…</option>
                {(lists.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.count})
                  </option>
                ))}
              </Select>
            )}
            <p className="text-xs text-slate-500">Phone numbers and emails are hashed (SHA-256) before upload; Facebook never sees them in plain text. Opted-out contacts are left out.</p>
          </>
        ) : (
          <>
            <Field label="Source audience" htmlFor="aud-src">
              <Select id="aud-src" value={form.sourceAudienceId} onChange={(e) => setForm({ ...form, sourceAudienceId: e.target.value })}>
                <option value="">Choose…</option>
                {(audiences.data ?? [])
                  .filter((a) => a.subtype !== 'LOOKALIKE')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" htmlFor="aud-country">
                <Input id="aud-country" maxLength={2} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={`Size: ${form.percent}%`} htmlFor="aud-pct" hint="1% = most similar, 10% = widest reach">
                <input id="aud-pct" type="range" min={1} max={10} value={form.percent} onChange={(e) => setForm({ ...form, percent: Number(e.target.value) })} className="w-full accent-[var(--color-brand-600)]" />
              </Field>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function NewPixelDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/facebook-ads/pixels`, { name }),
    onSuccess: () => {
      onDone();
      toast.success('Pixel created. Open it to copy the base code.');
      onClose();
    },
  });
  return (
    <Dialog icon={<Crosshair className="size-5" strokeWidth={1.5} />} title="New pixel" subtitle="Track conversions on your website." onClose={onClose} footer={<Footer onClose={onClose} onSave={() => save.mutate()} saving={save.isPending} disabled={!name.trim()} label="Create pixel" />}>
      {save.error != null && <div className="mb-3"><Alert>{errorMessage(save.error)}</Alert></div>}
      <Field label="Name" htmlFor="px-name">
        <Input id="px-name" autoFocus maxLength={100} placeholder="e.g. Clinic website" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
  );
}
