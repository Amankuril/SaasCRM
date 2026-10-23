import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import Papa from 'papaparse';
import { useState } from 'react';
import { api } from '../lib/api';
import { useWorkspace } from '../layouts/workspaceContext';
import { Modal } from './crm';
import { Alert, Button, Field, Select, cn, errorMessage } from './ui';

interface Report {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: { row: number; reason: string }[];
}

type FieldKey = 'phone' | 'name' | 'email' | 'tags' | 'lifecycleStage';
const FIELDS: { key: FieldKey; label: string; guess: RegExp; required?: boolean }[] = [
  { key: 'phone', label: 'Phone number', guess: /phone|mobile|whatsapp|number|contact/i, required: true },
  { key: 'name', label: 'Name', guess: /name/i },
  { key: 'email', label: 'Email', guess: /mail/i },
  { key: 'tags', label: 'Tags (comma or ; separated)', guess: /tag|label|group/i },
  { key: 'lifecycleStage', label: 'Lifecycle stage', guess: /stage|status/i },
];

const MAX_ROWS = 5000;

export function ImportContactsModal({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [duplicate, setDuplicate] = useState<'skip' | 'update' | 'merge'>('skip');
  const [parseError, setParseError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      api.post<{ report: Report }>(`/workspaces/${workspace.id}/contacts/import`, {
        rows,
        duplicate,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['tags', workspace.id] });
    },
  });

  function onFile(file: File) {
    setParseError(null);
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (result) => {
        const cols = (result.meta.fields ?? []).filter(Boolean);
        if (!cols.length || !result.data.length) return setParseError('This file has no header row or no data.');
        if (result.data.length > MAX_ROWS) return setParseError(`This file has ${result.data.length} rows. Import at most ${MAX_ROWS} at a time.`);
        setColumns(cols);
        setRows(result.data);
        // Guess the mapping from header names.
        const guessed: Partial<Record<FieldKey, string>> = {};
        for (const f of FIELDS) guessed[f.key] = cols.find((c) => f.guess.test(c) && !Object.values(guessed).includes(c));
        setMapping(guessed);
      },
      error: (err) => setParseError(err.message),
    });
  }

  const report = run.data?.report;

  return (
    <Modal title="Import contacts from CSV" onClose={onClose} wide>
      {report ? (
        <div className="space-y-4">
          <Alert tone="success">
            Import finished: {report.created} created, {report.updated} updated, {report.skipped} skipped, {report.invalid.length} invalid (of {report.total} rows).
          </Alert>
          {report.invalid.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">Rows that were not imported</p>
              <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
                {report.invalid.map((r) => (
                  <li key={r.row} className="flex gap-3 px-3 py-2">
                    <span className="w-16 shrink-0 text-slate-500">Row {r.row}</span>
                    <span className="text-slate-700">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-5">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:border-brand-500 hover:bg-brand-50/40">
            <FileUp className="size-6 text-slate-400" />
            <span className="text-sm font-medium text-slate-700">{fileName || 'Choose a CSV file'}</span>
            <span className="text-xs text-slate-500">First row must be column headers. Up to {MAX_ROWS} rows.</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
          {parseError && <Alert>{parseError}</Alert>}

          {columns.length > 0 && (
            <>
              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">Match columns ({rows.length} rows found)</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} htmlFor={`map-${f.key}`}>
                      <Select id={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}>
                        <option value="">{f.required ? 'Choose a column' : "Don't import"}</option>
                        {columns.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">Numbers without a country code are read as {workspace.country} numbers.</p>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">If a contact already exists</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ['skip', 'Skip it', 'Leave existing contacts unchanged.'],
                      ['merge', 'Fill empty fields', 'Only add missing details and tags.'],
                      ['update', 'Overwrite', 'Replace details with values from the file.'],
                    ] as const
                  ).map(([value, label, help]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDuplicate(value)}
                      className={cn('rounded-lg border p-3 text-left text-sm', duplicate === value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}
                    >
                      <span className="font-medium text-slate-800">{label}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{help}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">Preview</p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-slate-500">
                      <tr>
                        {FIELDS.filter((f) => mapping[f.key]).map((f) => (
                          <th key={f.key} className="px-3 py-2 font-medium">
                            {f.label.split(' (')[0]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          {FIELDS.filter((f) => mapping[f.key]).map((f) => (
                            <td key={f.key} className="px-3 py-2 text-slate-700">
                              {r[mapping[f.key]!]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {run.error != null && <Alert>{errorMessage(run.error)}</Alert>}
              <div className="flex gap-2">
                <Button loading={run.isPending} disabled={!mapping.phone} onClick={() => run.mutate()}>
                  Import {rows.length} rows
                </Button>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
