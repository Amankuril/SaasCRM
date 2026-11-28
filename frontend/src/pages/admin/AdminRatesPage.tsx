import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ReceiptIndianRupee, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AButton, AdminHeader, IconButton, Panel, useConfirm } from '../../components/admin';
import { Dialog } from '../../components/Dialog';
import { Alert, Field, Input, Select, Spinner, errorMessage, fieldError } from '../../components/ui';
import { api, type RateCard } from '../../lib/api';
import { pricingLabel } from '../reports/MessagePricingPage';

const CATEGORIES = ['marketing', 'utility', 'authentication', 'authentication_international', 'service'];

const marketLabel = (m: string) => {
  if (m === '*') return 'All other countries';
  try {
    return `${new Intl.DisplayNames(['en'], { type: 'region' }).of(m) ?? m} (${m})`;
  } catch {
    return m;
  }
};
const today = () => new Date().toISOString().slice(0, 10);

/** /admin/rates: Meta's price per billable message, used for every business's cost estimate. */
export function AdminRatesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const query = useQuery({ queryKey: ['admin', 'rate-cards'], queryFn: () => api.get<{ rates: RateCard[] }>('/admin/rate-cards') });
  const [editing, setEditing] = useState<RateCard | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/rate-cards/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'rate-cards'] }),
  });

  const rates = query.data?.rates ?? [];
  const now = today();

  return (
    <>
      <AdminHeader
        eyebrow="Billing"
        title="Message rates"
        description="What Meta charges per billable message, by recipient country and category. Businesses see cost estimates on their Message pricing report."
        actions={
          <AButton variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            Add rate
          </AButton>
        }
      />
      {remove.error != null && <div className="mb-4"><Alert>{errorMessage(remove.error)}</Alert></div>}
      <Panel flush title="Rate card" description="A country's own rate is used first, then the “All other countries” rate. Add a new row with a start date when Meta changes prices, so older reports keep the old price.">
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <div className="p-5"><Alert>{errorMessage(query.error)}</Alert></div>
        ) : rates.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            <ReceiptIndianRupee className="mx-auto mb-2 size-6 text-slate-400" strokeWidth={1.5} />
            No rates yet. Until you add some, reports show billable counts without a cost.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm whitespace-nowrap">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Country</th>
                  <th className="px-5 py-2 font-medium">Category</th>
                  <th className="px-5 py-2 text-right font-medium">Price (INR)</th>
                  <th className="px-5 py-2 font-medium">Valid</th>
                  <th className="px-5 py-2 font-medium">Note</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rates.map((r) => {
                  const current = r.validFrom <= now && (!r.validTo || now <= r.validTo);
                  return (
                    <tr key={r.id} className={current ? '' : 'text-slate-400'}>
                      <td className="px-5 py-2.5">{marketLabel(r.market)}</td>
                      <td className="px-5 py-2.5">{pricingLabel(r.category)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">₹{r.priceInr.toFixed(4)}</td>
                      <td className="px-5 py-2.5 whitespace-nowrap">
                        {r.validFrom} → {r.validTo ?? 'now'}
                        {current && <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">current</span>}
                      </td>
                      <td className="max-w-48 truncate px-5 py-2.5 text-slate-500">{r.note ?? ''}</td>
                      <td className="px-5 py-2.5 text-right whitespace-nowrap">
                        <IconButton icon={Pencil} label="Edit rate" onClick={() => setEditing(r)} />
                        <IconButton
                          icon={Trash2}
                          label="Remove rate"
                          onClick={async () => {
                            const ok = await confirm({ title: 'Remove this rate?', message: `${marketLabel(r.market)}, ${pricingLabel(r.category)}. Reports for its dates will show those messages without a cost. The row is kept in the activity log.`, confirmLabel: 'Remove rate', tone: 'danger' });
                            if (ok !== null) remove.mutate(r.id);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-4 text-xs text-slate-500">
        Take prices from Meta's WhatsApp pricing page. Businesses with a service fee (set on the business's page) see the estimate with that % added.
      </p>
      {editing && <RateModal rate={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RateModal({ rate, onClose }: { rate: RateCard | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    market: rate?.market ?? 'IN',
    category: rate?.category ?? 'marketing',
    priceInr: rate ? String(rate.priceInr) : '',
    validFrom: rate?.validFrom ?? today(),
    validTo: rate?.validTo ?? '',
    note: rate?.note ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { market: form.market.trim(), category: form.category, priceInr: Number(form.priceInr), validFrom: form.validFrom, validTo: form.validTo || null, note: form.note.trim() || null };
      return rate ? api.patch(`/admin/rate-cards/${rate.id}`, body) : api.post('/admin/rate-cards', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'rate-cards'] });
      onClose();
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <Dialog
      icon={<ReceiptIndianRupee className="size-5" strokeWidth={1.5} />}
      title={rate ? 'Edit rate' : 'Add rate'}
      subtitle="Price per billable message, in rupees"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <AButton onClick={onClose}>Cancel</AButton>
          <AButton variant="primary" loading={save.isPending} disabled={!form.priceInr || !form.validFrom} onClick={() => save.mutate()}>
            {rate ? 'Save' : 'Add rate'}
          </AButton>
        </div>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country code" htmlFor="rc-market" hint="IN, AE… or * for all others" error={fieldError(save.error, 'market')}>
            <Input id="rc-market" maxLength={2} value={form.market} onChange={set('market')} />
          </Field>
          <Field label="Category" htmlFor="rc-category" error={fieldError(save.error, 'category')}>
            <Select id="rc-category" value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {pricingLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Price per message (INR)" htmlFor="rc-price" error={fieldError(save.error, 'priceInr')}>
          <Input id="rc-price" type="number" min={0} step="0.0001" inputMode="decimal" placeholder="0.8631" value={form.priceInr} onChange={set('priceInr')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from" htmlFor="rc-from" error={fieldError(save.error, 'validFrom')}>
            <Input id="rc-from" type="date" value={form.validFrom} onChange={set('validFrom')} />
          </Field>
          <Field label="Valid to" htmlFor="rc-to" hint="Empty = until changed" error={fieldError(save.error, 'validTo')}>
            <Input id="rc-to" type="date" min={form.validFrom} value={form.validTo} onChange={set('validTo')} />
          </Field>
        </div>
        <Field label="Note" htmlFor="rc-note" hint="Optional, e.g. where the price came from">
          <Input id="rc-note" maxLength={200} value={form.note} onChange={set('note')} />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
