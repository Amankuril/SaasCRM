import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { api, type Contact } from '../lib/api';
import { useWorkspace } from '../layouts/workspaceContext';
import { Input, cn } from './ui';

export interface PickedContact {
  id: string;
  name: string;
  phone: string;
}

/** Search-as-you-type picker for one customer. */
export function ContactPicker({ value, onChange, id, disabled }: { value: PickedContact | null; onChange: (c: PickedContact | null) => void; id?: string; disabled?: boolean }) {
  const { workspace } = useWorkspace();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const deferred = useDeferredValue(q.trim());
  const results = useQuery({
    queryKey: ['contacts', workspace.id, 'picker', deferred],
    queryFn: () => api.get<{ contacts: Contact[] }>(`/workspaces/${workspace.id}/contacts?${new URLSearchParams({ q: deferred, limit: '8' })}`),
    enabled: open,
  });

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
        <span className="font-medium text-slate-800">{value.name}</span>
        <span className="font-mono text-xs text-slate-500">{value.phone}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange(null)} className="ml-auto rounded p-0.5 text-slate-400 hover:text-ink" aria-label="Clear customer">
            <X className="size-4" />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
      <Input
        id={id}
        disabled={disabled}
        placeholder="Search customers by name or number"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="pl-9"
      />
      {open && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {(results.data?.contacts ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ id: c.id, name: c.displayName, phone: c.phone });
                  setQ('');
                  setOpen(false);
                }}
                className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-slate-50')}
              >
                <span className="flex-1 truncate text-slate-800">{c.displayName}</span>
                <span className="font-mono text-xs text-slate-500">{c.phone}</span>
              </button>
            </li>
          ))}
          {results.data && results.data.contacts.length === 0 && <li className="px-2.5 py-2 text-xs text-slate-500">No customers match.</li>}
        </ul>
      )}
    </div>
  );
}
