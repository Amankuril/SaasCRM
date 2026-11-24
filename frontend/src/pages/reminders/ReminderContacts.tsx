import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, FileSpreadsheet, Pause, Pencil, Play, Plus, Search, Trash2, Users } from 'lucide-react';
import { useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { Alert, Button, Card, EmptyState, Field, Input, LoadError, Select, errorMessage, fieldError } from '../../components/ui';
import { api, type ReminderCategory, type ReminderRecord, type ReminderRecurrence, type ReminderSetup } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ImportDialog } from './ImportDialog';
import { Pager } from './Pager';
import { RECURRENCE_LABEL, dateTime, ruleIdText } from './shared';

const STATUS: Record<ReminderRecord['status'], { badge: string; label: string }> = {
  active: { badge: 'active', label: 'Scheduled' },
  waiting: { badge: 'draft', label: 'Not live yet' },
  paused: { badge: 'paused', label: 'Paused' },
  completed: { badge: 'archived', label: 'Finished' },
};

export function ReminderContacts({ setup, category, timezone, url, canManage, locked }: { setup: ReminderSetup; category: ReminderCategory; timezone: string; url: string; canManage: boolean; locked: boolean }) {
  const { workspace, can } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ReminderRecord | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  useEffect(() => setPage(1), [deferredQ, status]);

  const list = useQuery({
    queryKey: ['reminders', workspace.id, 'setup', setup.id, 'records', { deferredQ, status, page }],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (deferredQ) p.set('q', deferredQ);
      if (status) p.set('status', status);
      return api.get<{ records: ReminderRecord[]; total: number; pages: number }>(`${url}/records?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'done' }) => api.post(`${url}/records/${id}/${action}`, {}),
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });
  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: 'pause' | 'resume' | 'delete' }) => api.post(`${url}/records-bulk`, { ids, action }),
    onSuccess: () => {
      setSelected(new Set());
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(e),
  });

  const rows = list.data?.records ?? [];
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const add = canManage && !locked;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" strokeWidth={1.5} />
          <Input aria-label="Search contacts" placeholder="Name or number" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Status" className="w-40!" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Scheduled</option>
          <option value="paused">Paused</option>
          <option value="completed">Finished</option>
        </Select>
        {selected.size > 0 && canManage && (
          <div className="flex items-center gap-1 text-sm text-slate-600">
            <span className="px-2 tabular-nums">{selected.size} selected</span>
            <Button variant="ghost" onClick={() => bulk.mutate({ ids: [...selected], action: 'pause' })}>
              Pause
            </Button>
            <Button variant="ghost" onClick={() => bulk.mutate({ ids: [...selected], action: 'resume' })}>
              Resume
            </Button>
            <Button variant="ghost" className="text-red-600" onClick={() => setDeleting([...selected])}>
              Delete
            </Button>
          </div>
        )}
        {add && (
          <div className="ml-auto flex gap-2">
            {can('contacts:import') && (
              <Button variant="secondary" onClick={() => setImporting(true)}>
                <FileSpreadsheet className="size-4" strokeWidth={1.5} /> Import file
              </Button>
            )}
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add contact
            </Button>
          </div>
        )}
      </div>

      <Card className="overflow-hidden">
        {list.error ? (
          <LoadError error={list.error} what="contacts" onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users className="size-5" strokeWidth={1.5} />} title={deferredQ || status ? 'No contacts match' : 'No contacts yet'}>
            {deferredQ || status ? 'Try another search or status.' : `Import a file with each ${category.person.toLowerCase()}’s ${category.dateLabel.toLowerCase()}, or add them one by one.`}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  {canManage && (
                    <th className="w-10 pl-4">
                      <input type="checkbox" aria-label="Select all" className="size-4 accent-brand-600" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} />
                    </th>
                  )}
                  <th className="px-4 py-2.5 font-normal">{category.person}</th>
                  <th className="px-4 py-2.5 font-normal">{setup.eventLabel ?? category.dateLabel}</th>
                  {setup.fields.slice(0, 2).map((f) => (
                    <th key={f.key} className="px-4 py-2.5 font-normal">
                      {f.label}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 font-normal">Next reminder</th>
                  <th className="px-4 py-2.5 font-normal">Status</th>
                  {canManage && <th className="w-40" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-slate-50">
                    {canManage && (
                      <td className="pl-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name || r.phone}`}
                          className="size-4 accent-brand-600"
                          checked={selected.has(r.id)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (!next.delete(r.id)) next.add(r.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="block font-medium text-ink">{r.name || 'No name'}</span>
                      <span className="block text-xs text-slate-500">{r.phone}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                      {r.eventDateLabel}
                      {r.eventTimeLabel && <span className="block text-xs text-slate-500">{r.eventTimeLabel}</span>}
                    </td>
                    {setup.fields.slice(0, 2).map((f) => (
                      <td key={f.key} className="max-w-40 truncate px-4 py-3 text-slate-600" title={r.fields[f.key]}>
                        {r.fields[f.key]}
                      </td>
                    ))}
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                      {r.nextRunAt ? dateTime(r.nextRunAt, timezone) : r.status === 'waiting' && r.nextRuleId ? 'After you activate' : 'None'}
                      {r.nextRuleId && r.status !== 'completed' && r.status !== 'paused' && <span className="block text-xs text-slate-500">{ruleIdText(r.nextRuleId)}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={STATUS[r.status].badge} label={STATUS[r.status].label} />
                    </td>
                    {canManage && (
                      <td className="px-2 py-2">
                        <div className="flex justify-end">
                          {category.doneLabel && r.status !== 'completed' && (
                            <RowButton label={`Mark ${category.doneLabel.toLowerCase()}`} onClick={() => act.mutate({ id: r.id, action: 'done' })}>
                              <Check className="size-4" strokeWidth={1.5} />
                            </RowButton>
                          )}
                          {r.status === 'paused' ? (
                            <RowButton label="Resume" onClick={() => act.mutate({ id: r.id, action: 'resume' })}>
                              <Play className="size-4" strokeWidth={1.5} />
                            </RowButton>
                          ) : (
                            r.status !== 'completed' && (
                              <RowButton label="Pause" onClick={() => act.mutate({ id: r.id, action: 'pause' })}>
                                <Pause className="size-4" strokeWidth={1.5} />
                              </RowButton>
                            )
                          )}
                          <RowButton label="Edit" onClick={() => setEditing(r)}>
                            <Pencil className="size-4" strokeWidth={1.5} />
                          </RowButton>
                          <RowButton label="Delete" onClick={() => setDeleting([r.id])}>
                            <Trash2 className="size-4" strokeWidth={1.5} />
                          </RowButton>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.total > 0 && <Pager page={page} pages={list.data.pages} total={list.data.total} noun="contact" onChange={setPage} />}
      </Card>

      {editing && <RecordDialog setup={setup} category={category} url={url} record={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {importing && <ImportDialog setup={setup} category={category} url={url} onClose={() => setImporting(false)} />}
      {deleting && (
        <ConfirmDialog title={deleting.length === 1 ? 'Delete contact' : `Delete ${deleting.length} contacts`} loading={bulk.isPending} onConfirm={() => bulk.mutate({ ids: deleting, action: 'delete' })} onClose={() => setDeleting(null)}>
          They are removed from this reminder only. Reminders already sent stay in the log.
        </ConfirmDialog>
      )}
    </>
  );
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-ink">
      {children}
    </button>
  );
}

function RecordDialog({ setup, category, url, record, onClose, onSaved }: { setup: ReminderSetup; category: ReminderCategory; url: string; record: ReminderRecord | null; onClose: () => void; onSaved: () => void }) {
  const [phone, setPhone] = useState(record?.phone ?? '');
  const [name, setName] = useState(record?.name ?? '');
  // A birthday saved without a year is shown and edited as "14 Aug".
  const yearless = !!record && record.eventDate.startsWith('1904');
  const [date, setDate] = useState(yearless ? record.eventDateLabel : (record?.eventDate ?? ''));
  const [time, setTime] = useState(record?.eventTime ?? '');
  const [fields, setFields] = useState<Record<string, string>>(record?.fields ?? {});
  const [endDate, setEndDate] = useState(record?.endDate ?? '');
  const [maxCycles, setMaxCycles] = useState(record?.maxCycles ? String(record.maxCycles) : '');
  const [recurrence, setRecurrence] = useState<ReminderRecurrence | ''>(record?.recurrence ?? '');
  const repeats = (recurrence || setup.recurrence) !== 'none';

  const save = useMutation({
    mutationFn: () => {
      const body = { phone, name, date, time, fields, endDate: repeats && endDate ? endDate : null, maxCycles: repeats && maxCycles ? Number(maxCycles) : null, recurrence: recurrence || null };
      return record ? api.put(`${url}/records/${record.id}`, body) : api.post(`${url}/records`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const err = (f: string) => fieldError(save.error, f);

  return (
    <Dialog
      width="max-w-xl"
      icon={<CalendarPlus className="size-4" strokeWidth={1.5} />}
      title={record ? 'Edit contact' : `Add ${category.person.toLowerCase()}`}
      subtitle={setup.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} form="reminder-record" type="submit">
            {record ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form id="reminder-record" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {save.error != null && (
          <div className="sm:col-span-2">
            <Alert>{errorMessage(save.error)}</Alert>
          </div>
        )}
        <Field label={`${category.person} name`} htmlFor="rec-name">
          <Input id="rec-name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="WhatsApp number" htmlFor="rec-phone" error={err('phone')}>
          <Input id="rec-phone" inputMode="tel" value={phone} invalid={!!err('phone')} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={setup.eventLabel ?? category.dateLabel} htmlFor="rec-date" error={err('date')} hint={category.yearOptional ? 'The year is optional, for example 14 Aug' : undefined}>
          <Input id="rec-date" type={category.yearOptional ? 'text' : 'date'} placeholder={category.yearOptional ? '14/08/1990' : undefined} value={date} invalid={!!err('date')} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {category.dateKind === 'datetime' && (
          <Field label="Time" htmlFor="rec-time" error={err('time')}>
            <Input id="rec-time" type="time" value={time} invalid={!!err('time')} onChange={(e) => setTime(e.target.value)} />
          </Field>
        )}
        {setup.fields.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`rec-${f.key}`} error={err(f.key)}>
            {f.type === 'select' ? (
              <Select id={`rec-${f.key}`} value={fields[f.key] ?? ''} invalid={!!err(f.key)} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}>
                <option value="">Choose</option>
                {/* An imported value outside the list stays selectable. */}
                {[...new Set([...(f.options ?? []), ...(fields[f.key] ? [fields[f.key]!] : [])])].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input id={`rec-${f.key}`} placeholder={f.example} value={fields[f.key] ?? ''} maxLength={500} invalid={!!err(f.key)} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
        {category.recurrences.length > 1 && (
          <Field label="Repeats" htmlFor="rec-repeat">
            <Select id="rec-repeat" value={recurrence} onChange={(e) => setRecurrence(e.target.value as ReminderRecurrence | '')}>
              <option value="">Same as the setup</option>
              {category.recurrences.map((r) => (
                <option key={r} value={r}>
                  {RECURRENCE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {repeats && category.key !== 'birthdays' && (
          <>
            <Field label="Stop after date" htmlFor="rec-end" error={err('endDate')} hint="Optional">
              <Input id="rec-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
            <Field label="Number of cycles" htmlFor="rec-cycles" hint="Optional, for example 24 EMIs">
              <Input id="rec-cycles" type="number" min={1} max={1000} value={maxCycles} onChange={(e) => setMaxCycles(e.target.value)} />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}
