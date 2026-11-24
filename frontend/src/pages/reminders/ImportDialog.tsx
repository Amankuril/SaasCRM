import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Field, Select, errorMessage } from '../../components/ui';
import { api, type ReminderCategory, type ReminderImportReport, type ReminderSetup } from '../../lib/api';
import { readSpreadsheet, type ParsedFile } from '../../lib/spreadsheet';
import { useWorkspace } from '../../layouts/workspaceContext';
import { occurrenceText } from './shared';

const MAX_ROWS = 5000;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

interface Target {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
  example: string;
}

/** Upload, match columns, check, import. */
export function ImportDialog({ setup, category, url, onClose }: { setup: ReminderSetup; category: ReminderCategory; url: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dateOrder, setDateOrder] = useState<'dmy' | 'mdy'>('dmy');
  const [duplicate, setDuplicate] = useState<'skip' | 'update'>('skip');

  const targets: Target[] = [
    { key: 'phone', label: 'WhatsApp number', required: true, aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'mobile no', 'whatsapp', 'whatsapp number', 'contact', 'contact number', 'number'], example: '9810010000' },
    { key: 'name', label: `${category.person} name`, aliases: ['name', 'full name', 'customer', 'customer name', 'client', 'client name', 'patient', 'patient name', 'employee', 'employee name', 'holder'], example: 'Rahul Verma' },
    { key: 'date', label: setup.eventLabel ?? category.dateLabel, required: true, aliases: [...category.dateAliases, ...(setup.eventLabel ? [setup.eventLabel] : [])], example: category.yearOptional ? '14/08/1990' : '01/12/2026' },
    ...(category.dateKind === 'datetime' ? [{ key: 'time', label: 'Time', aliases: ['time', 'event time', 'appointment time', 'slot'], example: '11:30 AM' }] : []),
    ...setup.fields.map((f) => ({ key: `f.${f.key}`, label: f.label, required: f.required, aliases: [f.label, f.key, ...(f.aliases ?? [])], example: f.example })),
    ...(setup.recurrence !== 'none' ? [{ key: 'endDate', label: 'Stop after date', aliases: ['end date', 'last date', 'closing date'], example: '' }] : []),
  ];

  const body = () => ({
    rows: file!.rows,
    mapping: {
      phone: mapping.phone ?? '',
      date: mapping.date ?? '',
      ...(mapping.name ? { name: mapping.name } : {}),
      ...(mapping.time ? { time: mapping.time } : {}),
      ...(mapping.endDate ? { endDate: mapping.endDate } : {}),
      fields: Object.fromEntries(Object.entries(mapping).flatMap(([k, v]) => (k.startsWith('f.') && v ? [[k.slice(2), v]] : []))),
    },
    dateOrder,
    duplicate,
  });
  const check = useMutation({ mutationFn: () => api.post<{ report: ReminderImportReport }>(`${url}/import`, { ...body(), dryRun: true }) });
  const run = useMutation({
    mutationFn: () => api.post<{ report: ReminderImportReport }>(`${url}/import`, body()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] }),
  });
  const reset = () => {
    check.reset();
    run.reset();
  };

  async function onFile(f: File) {
    reset();
    setFileError(null);
    setFile(null);
    setFileName(f.name);
    try {
      const parsed = await readSpreadsheet(f, MAX_ROWS);
      // Match headings to fields; each heading is used once.
      const used = new Set<string>();
      const guess: Record<string, string> = {};
      for (const exact of [true, false]) {
        for (const t of targets) {
          if (guess[t.key]) continue;
          const names = t.aliases.map(norm);
          const hit = parsed.columns.find((c) => !used.has(c) && (exact ? names.includes(norm(c)) : t.required && names.some((n) => norm(c).includes(n))));
          if (hit) {
            guess[t.key] = hit;
            used.add(hit);
          }
        }
      }
      setMapping(guess);
      setFile(parsed);
    } catch (err) {
      setFileError((err as Error).message);
    }
  }

  const sampleFile = () => {
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = `${targets.map((t) => cell(t.label)).join(',')}\n${targets.map((t) => cell(t.example)).join(',')}\n`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${category.key}-sample.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const report = run.data?.report;
  const checked = check.data?.report;
  const ready = !!file && targets.every((t) => !t.required || mapping[t.key]);

  return (
    <Dialog
      width="max-w-3xl"
      icon={<FileSpreadsheet className="size-4" strokeWidth={1.5} />}
      title="Import contacts"
      subtitle="CSV or Excel, up to 5,000 rows"
      onClose={onClose}
      footer={
        report ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {checked ? (
              <Button loading={run.isPending} disabled={!checked.valid} onClick={() => run.mutate()}>
                Import {checked.valid} contact{checked.valid === 1 ? '' : 's'}
              </Button>
            ) : (
              <Button disabled={!ready} loading={check.isPending} onClick={() => check.mutate()}>
                Check file
              </Button>
            )}
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4">
          <Alert tone="success">
            {report.created} added{report.updated ? `, ${report.updated} updated` : ''}
            {report.duplicates - report.updated > 0 ? `, ${report.duplicates - report.updated} already in the list` : ''}
            {report.invalid.length ? `, ${report.invalid.length} rows not imported` : ''}
          </Alert>
          <InvalidRows rows={report.invalid} />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-700 focus-within:ring-3 focus-within:ring-brand-600/15 hover:bg-slate-100">
              <FileSpreadsheet className="size-4" strokeWidth={1.5} /> {file ? 'Choose another file' : 'Choose file'}
              <input
                type="file"
                className="sr-only"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  if (e.target.files?.[0]) void onFile(e.target.files[0]);
                  e.target.value = '';
                }}
              />
            </label>
            <span className="text-sm text-slate-500">{file ? `${fileName}, ${file.rows.length} rows` : 'The first row must be column headings'}</span>
            <button type="button" onClick={sampleFile} className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
              <Download className="size-4" strokeWidth={1.5} /> Sample file
            </button>
          </div>
          {fileError && <Alert>{fileError}</Alert>}

          {file && (
            <>
              <div>
                <p className="mb-3 text-sm font-medium text-slate-700">Match your columns</p>
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  {targets.map((t) => (
                    <Field key={t.key} label={t.required ? `${t.label} (required)` : t.label} htmlFor={`m-${t.key}`} hint={mapping[t.key] && file.rows[0]?.[mapping[t.key]!] ? `First row: ${file.rows[0][mapping[t.key]!]}` : undefined}>
                      <Select
                        id={`m-${t.key}`}
                        value={mapping[t.key] ?? ''}
                        onChange={(e) => {
                          reset();
                          setMapping({ ...mapping, [t.key]: e.target.value });
                        }}
                      >
                        <option value="">{t.required ? 'Choose a column' : 'Not in my file'}</option>
                        {file.columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Dates are written as" htmlFor="m-order">
                  <Select
                    id="m-order"
                    value={dateOrder}
                    onChange={(e) => {
                      reset();
                      setDateOrder(e.target.value as 'dmy' | 'mdy');
                    }}
                  >
                    <option value="dmy">Day, month, year (31/12/2026)</option>
                    <option value="mdy">Month, day, year (12/31/2026)</option>
                  </Select>
                </Field>
                <Field label="If the event is already in the list" htmlFor="m-dup">
                  <Select
                    id="m-dup"
                    value={duplicate}
                    onChange={(e) => {
                      reset();
                      setDuplicate(e.target.value as 'skip' | 'update');
                    }}
                  >
                    <option value="skip">Keep what is there</option>
                    <option value="update">Update it from the file</option>
                  </Select>
                </Field>
              </div>
              {(check.error ?? run.error) != null && <Alert>{errorMessage(check.error ?? run.error)}</Alert>}
              {checked && (
                <div className="space-y-3">
                  <p className="text-sm text-slate-700">
                    <strong className="font-medium text-ink tabular-nums">{checked.valid}</strong> of {checked.total} rows can be imported
                    {checked.duplicates ? `, ${checked.duplicates} already in the list` : ''}
                  </p>
                  {checked.sample.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                            <th className="px-3 py-2 font-normal">Name</th>
                            <th className="px-3 py-2 font-normal">Number</th>
                            <th className="px-3 py-2 font-normal">{setup.eventLabel ?? category.dateLabel}</th>
                            {setup.fields.map((f) => (
                              <th key={f.key} className="px-3 py-2 font-normal">
                                {f.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700">
                          {checked.sample.map((r) => (
                            <tr key={r.row}>
                              <td className="px-3 py-2">{r.name}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{r.phone}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{r.eventDate.startsWith('1904') ? occurrenceText(r.eventDate).replace(/,? ?1904/, '') : occurrenceText(r.eventTime ? `${r.eventDate}T${r.eventTime}` : r.eventDate)}</td>
                              {setup.fields.map((f) => (
                                <td key={f.key} className="px-3 py-2">
                                  {r.fields[f.key]}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <InvalidRows rows={checked.invalid} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function InvalidRows({ rows }: { rows: { row: number; reason: string }[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-700">Rows that will not be imported</p>
      <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
        {rows.slice(0, 200).map((r) => (
          <li key={r.row} className="flex gap-3 px-3 py-2">
            <span className="w-16 shrink-0 text-slate-500 tabular-nums">Row {r.row}</span>
            <span className="text-slate-700">{r.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
