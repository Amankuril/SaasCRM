import type { VariableSpec } from '../lib/api';
import { Input, Select, cn } from './ui';

const FIELD_OPTIONS = [
  { value: 'first_name', label: 'First name' },
  { value: 'name', label: 'Full name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
];

/** Maps one template variable to a contact field, custom field or fixed text (with fallback). */
export function VariableRow({ label, spec, onChange, disabled }: { label: string; spec: VariableSpec; onChange: (s: VariableSpec) => void; disabled: boolean }) {
  const isCustom = spec.source === 'field' && spec.value.startsWith('custom.');
  const mode = spec.source === 'static' ? 'static' : isCustom ? 'custom' : spec.value;
  return (
    <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[7rem_1fr_1fr] sm:items-center">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className={cn('grid gap-2', mode === 'static' || mode === 'custom' ? 'grid-cols-2' : 'grid-cols-1', spec.source === 'static' && 'sm:col-span-2')}>
        <Select
          aria-label={`${label} source`}
          disabled={disabled}
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'static') onChange({ source: 'static', value: '', fallback: '' });
            else if (v === 'custom') onChange({ source: 'field', value: 'custom.', fallback: spec.fallback });
            else onChange({ source: 'field', value: v, fallback: spec.fallback });
          }}
        >
          {FIELD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Contact: {o.label}
            </option>
          ))}
          <option value="custom">Contact: custom field</option>
          <option value="static">Same text for everyone</option>
        </Select>
        {(mode === 'static' || mode === 'custom') && (
          <Input
            aria-label={`${label} value`}
            placeholder={mode === 'static' ? 'Text' : 'field_key'}
            disabled={disabled}
            value={mode === 'custom' ? spec.value.slice(7) : spec.value}
            onChange={(e) => onChange({ ...spec, value: mode === 'custom' ? `custom.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` : e.target.value })}
          />
        )}
      </div>
      {spec.source === 'field' && (
        <Input aria-label={`${label} fallback`} placeholder="Fallback if empty (optional)" disabled={disabled} value={spec.fallback} onChange={(e) => onChange({ ...spec, fallback: e.target.value })} />
      )}
    </div>
  );
}
