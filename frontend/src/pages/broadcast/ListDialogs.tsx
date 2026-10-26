import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, ListPlus, Tags, Upload, UserPlus, Users } from 'lucide-react';
import Papa from 'papaparse';
import { useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type Contact, type ContactList, type ListImportReport } from '../../lib/api';
import { DIAL_CODES } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';

const MAX_ROWS = 5_000;

function useInvalidateLists() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['contact-lists', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
  };
}

function Label({ htmlFor, children, required }: { htmlFor?: string; children: ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-600">
      {children}
      {required && <span className="text-red-500"> *</span>}
    </label>
  );
}

function CountrySelect({ id, value, onChange, disabled, placeholder = 'Select country code...' }: { id: string; value: string; onChange: (iso: string) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {DIAL_CODES.map((c) => (
        <option key={c.iso} value={c.iso}>
          {c.name} (+{c.dial})
        </option>
      ))}
    </Select>
  );
}

export function NewListDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (list: ContactList) => void }) {
  const { workspace } = useWorkspace();
  const invalidate = useInvalidateLists();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ list: ContactList }>(`/workspaces/${workspace.id}/contact-lists`, { name }),
    onSuccess: ({ list }) => {
      invalidate();
      onCreated?.(list);
      onClose();
    },
  });
  return (
    <Dialog
      icon={<ListPlus className="size-4" />}
      title="Create a New Contact List"
      subtitle="A separate contact book for organizing your audience."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim()} loading={create.isPending} className="bg-slate-700 hover:bg-slate-800">
            Create List
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Label htmlFor="list-name" required>
          List name
        </Label>
        <Input id="list-name" autoFocus maxLength={255} placeholder="e.g. Diwali Leads" value={name} onChange={(e) => setName(e.target.value)} invalid={!!create.error} />
        <div className="mt-1.5 flex justify-between text-xs text-slate-500">
          <span>{create.error != null ? <span className="text-red-600">{fieldError(create.error, 'name') ?? errorMessage(create.error)}</span> : 'Used to group contacts for campaigns.'}</span>
          <span>{name.length}/255</span>
        </div>
      </form>
    </Dialog>
  );
}

type Mode = 'one' | 'bulk' | 'tags';

export function AddContactDialog({ list, onClose }: { list: ContactList; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('one');
  const tabs: { key: Mode; label: string; icon: typeof Users }[] = [
    { key: 'one', label: 'One by One', icon: UserPlus },
    { key: 'bulk', label: 'Bulk Upload', icon: Upload },
    { key: 'tags', label: 'Bulk (with Tags)', icon: Tags },
  ];
  return (
    <Dialog icon={<UserPlus className="size-4" />} title="Add Contact" subtitle={`List: ${list.name}`} onClose={onClose} width="max-w-2xl">
      <div className="-mx-5 -mt-5 mb-5 flex flex-wrap gap-2 border-b border-slate-200 px-5 py-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setMode(t.key)}
            className={cn('inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium', mode === t.key ? 'bg-slate-100 text-ink ring-1 ring-slate-200' : 'text-slate-600 hover:bg-slate-50')}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      {mode === 'one' ? <OneByOne list={list} onClose={onClose} /> : <BulkUpload key={mode} list={list} withTags={mode === 'tags'} onClose={onClose} />}
    </Dialog>
  );
}

function FormFooter({ children }: { children: ReactNode }) {
  return <div className="-mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{children}</div>;
}

function OneByOne({ list, onClose }: { list: ContactList; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const invalidate = useInvalidateLists();
  const [country, setCountry] = useState(DIAL_CODES.some((c) => c.iso === workspace.country) ? workspace.country : 'IN');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post<{ contact: Contact; created: boolean; alreadyInList: boolean }>(`/workspaces/${workspace.id}/contact-lists/${list.id}/contacts`, { country, phone, name: name || undefined }),
    onSuccess: ({ contact, created, alreadyInList }) => {
      invalidate();
      setDone(alreadyInList ? `${contact.displayName} is already in this list.` : created ? `Added ${contact.displayName} (${contact.phone}).` : `${contact.displayName} was already a contact and is now in this list.`);
      setPhone('');
      setName('');
    },
  });
  const err = save.error;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        save.mutate();
      }}
    >
      <div className="space-y-4">
        {done && <Alert tone="success">{done} Add another, or close.</Alert>}
        {err != null && !fieldError(err, 'phone') && !fieldError(err, 'country') && <Alert>{errorMessage(err)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="one-country">Country code</Label>
            <CountrySelect id="one-country" value={country} onChange={setCountry} />
            {fieldError(err, 'country') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'country')}</p>}
          </div>
          <div>
            <Label htmlFor="one-phone">WhatsApp number</Label>
            <Input id="one-phone" type="tel" inputMode="tel" placeholder="9876543210" value={phone} onChange={(e) => setPhone(e.target.value)} invalid={!!fieldError(err, 'phone')} />
            {fieldError(err, 'phone') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'phone')}</p>}
          </div>
        </div>
        <div>
          <Label htmlFor="one-name">Customer name</Label>
          <Input id="one-name" maxLength={200} placeholder="Enter customer name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <FormFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {done ? 'Close' : 'Cancel'}
        </Button>
        <Button type="submit" disabled={!phone.trim() || !country} loading={save.isPending} className="bg-slate-700 hover:bg-slate-800">
          Save Contact
        </Button>
      </FormFooter>
    </form>
  );
}

function downloadSample(withTags: boolean) {
  const rows = withTags ? ['Mr. John,918757648374,"VIP;Dental"', 'Mr. Adam,919898459876,Dental'] : ['Mr. John,918757648374', 'Mr. Adam,919898459876'];
  const url = URL.createObjectURL(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: withTags ? 'contacts-with-tags-sample.csv' : 'contacts-sample.csv' });
  a.click();
  URL.revokeObjectURL(url);
}

function BulkUpload({ list, withTags, onClose }: { list: ContactList; withTags: boolean; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const invalidate = useInvalidateLists();
  const fileRef = useRef<HTMLInputElement>(null);
  const [international, setInternational] = useState(true);
  const [country, setCountry] = useState('');
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = useMutation({
    mutationFn: () =>
      api.post<{ report: ListImportReport }>(`/workspaces/${workspace.id}/contact-lists/${list.id}/import`, {
        rows: file!.rows,
        international,
        ...(international ? {} : { country }),
        withTags,
      }),
    onSuccess: () => invalidate(),
  });

  const read = (f: File | undefined) => {
    setParseError(null);
    upload.reset();
    if (!f) return;
    if (!/\.(csv|txt)$/i.test(f.name)) return setParseError('Upload a .csv file (save Excel sheets as CSV first).');
    Papa.parse<string[]>(f, {
      skipEmptyLines: 'greedy',
      complete: (result) => {
        const rows = result.data.map((r) => r.slice(0, withTags ? 3 : 2).map((c) => String(c ?? '').trim()));
        if (!rows.length) return setParseError('The file is empty.');
        if (rows.length > MAX_ROWS) return setParseError(`The file has ${rows.length} rows. Upload at most ${MAX_ROWS} at a time.`);
        setFile({ name: f.name, rows });
      },
      error: () => setParseError('Could not read this file.'),
    });
  };

  const report = upload.data?.report;
  const guide = [
    { col: 'Col 1', title: 'Name', hint: 'e.g. Mr. John' },
    { col: 'Col 2', title: 'Number — country code + number, no "+", no spaces', hint: 'e.g. 918757648374' },
    ...(withTags ? [{ col: 'Col 3', title: 'Tags — separate several with ";" (or quote them with commas)', hint: 'e.g. VIP;Dental' }] : []),
  ];

  return (
    <div>
      <div className="space-y-2">
        <Label htmlFor="bulk-country">Numbers without a country code are from</Label>
        <CountrySelect id="bulk-country" value={country} onChange={setCountry} disabled={international} />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={international} onChange={(e) => setInternational(e.target.checked)} />
          Every number in my file already includes its country code
        </label>
        <p className="text-sm text-slate-500">
          {international ? 'Numbers are used exactly as written — none will be completed.' : 'Numbers without a country code get the one you chose; numbers that have one are kept.'}
        </p>
        {fieldError(upload.error, 'country') && <p className="text-xs text-red-600">{fieldError(upload.error, 'country')}</p>}
      </div>

      <div className="mt-4 grid overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-[1fr_15rem]">
        <div className="space-y-3 p-4">
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => read(e.target.files?.[0])} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              read(e.dataTransfer.files[0]);
            }}
            className={cn('flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-sm text-slate-600', dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}
          >
            <span className="rounded-xl bg-sky-50 p-3 text-sky-600">
              <FileSpreadsheet className="size-5" />
            </span>
            {file ? (
              <span>
                <strong className="text-ink">{file.name}</strong> · {file.rows.length} row{file.rows.length === 1 ? '' : 's'} · click to replace
              </span>
            ) : (
              <span>
                Drop a file here or <strong className="text-ink">click to upload</strong>
              </span>
            )}
          </button>
          <Button type="button" variant="secondary" className="w-full" onClick={() => downloadSample(withTags)}>
            <Download className="size-4" /> Download Sample CSV
          </Button>
          {parseError && <Alert>{parseError}</Alert>}
          {file && !report && (
            <div className="overflow-hidden rounded-lg border border-slate-200 text-xs">
              <p className="bg-slate-50 px-3 py-1.5 font-medium text-slate-600">First rows</p>
              <table className="w-full">
                <tbody>
                  {file.rows.slice(0, 3).map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {r.map((c, j) => (
                        <td key={j} className="truncate px-3 py-1.5 text-slate-700">
                          {c || <span className="text-slate-300">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="border-t border-slate-200 bg-slate-50 sm:border-t-0 sm:border-l">
          <p className="border-b border-slate-200 px-4 py-2.5 text-xs font-semibold tracking-wider text-slate-500 uppercase">CSV format guide</p>
          <div className="space-y-2 p-4 text-xs">
            <p className="text-slate-600">No header row — data starts from the first line:</p>
            <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {guide.map((g) => (
                <div key={g.col} className="px-3 py-2">
                  <p className="font-medium text-slate-700">{g.col}</p>
                  <p className="text-slate-600">{g.title}</p>
                  <p className="text-slate-400 italic">{g.hint}</p>
                </div>
              ))}
            </div>
            <p className="text-slate-500">Up to {MAX_ROWS.toLocaleString()} rows per file. Numbers already in your contacts just join this list.</p>
          </div>
        </div>
      </div>

      {upload.error != null && !fieldError(upload.error, 'country') && (
        <div className="mt-4">
          <Alert>{fieldError(upload.error, 'rows') ?? errorMessage(upload.error)}</Alert>
        </div>
      )}
      {report && (
        <div className="mt-4 space-y-2">
          <Alert tone={report.invalid.length ? 'info' : 'success'}>
            {report.created} new contact{report.created === 1 ? '' : 's'} created, {report.added} existing contact{report.added === 1 ? '' : 's'} added
            {report.alreadyInList ? `, ${report.alreadyInList} already in the list` : ''}
            {report.invalid.length ? `, ${report.invalid.length} row${report.invalid.length === 1 ? '' : 's'} skipped` : ''}.
          </Alert>
          {report.invalid.length > 0 && (
            <ul className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
              {report.invalid.slice(0, 50).map((r) => (
                <li key={r.row}>
                  Row {r.row}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <FormFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {report ? 'Done' : 'Cancel'}
        </Button>
        <Button onClick={() => upload.mutate()} disabled={!file || (!international && !country) || !!report} loading={upload.isPending} className="bg-slate-700 hover:bg-slate-800">
          Import Contacts
        </Button>
      </FormFooter>
    </div>
  );
}

export function AssignListsDialog({ contactIds, onClose, onDone }: { contactIds: string[]; onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const invalidate = useInvalidateLists();
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`) });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const assign = useMutation({
    mutationFn: () => api.post<{ updated: number }>(`/workspaces/${workspace.id}/contact-lists/assign`, { contactIds, listIds: [...chosen] }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  return (
    <>
      <Dialog
        icon={<Users className="size-4" />}
        title="Assign Lists"
        subtitle={`${contactIds.length} contact${contactIds.length === 1 ? '' : 's'} selected`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => assign.mutate()} disabled={!chosen.size} loading={assign.isPending} className="bg-slate-700 hover:bg-slate-800">
              Add to {chosen.size || ''} list{chosen.size === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        {assign.error != null && <Alert>{errorMessage(assign.error)}</Alert>}
        {lists.isPending ? (
          <Spinner />
        ) : (
          <div className="space-y-1.5">
            {lists.data?.lists.map((l) => (
              <label key={l.id} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 text-sm', chosen.has(l.id) ? 'border-slate-500 bg-slate-50' : 'border-slate-200')}>
                <input
                  type="checkbox"
                  checked={chosen.has(l.id)}
                  onChange={() => {
                    const next = new Set(chosen);
                    if (next.has(l.id)) next.delete(l.id);
                    else next.add(l.id);
                    setChosen(next);
                  }}
                />
                <span className="flex-1 font-medium text-slate-800">{l.name}</span>
                <span className="text-xs text-slate-500">{l.count} contacts</span>
              </label>
            ))}
            <button type="button" onClick={() => setCreating(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              + New list
            </button>
          </div>
        )}
      </Dialog>
      {creating && <NewListDialog onClose={() => setCreating(false)} onCreated={(l) => setChosen(new Set([...chosen, l.id]))} />}
    </>
  );
}
