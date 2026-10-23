import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { COUNTRIES, CURRENCIES, INDUSTRIES, browserTimeZone, timeZones } from '../lib/options';
import { Alert, Button, Field, Input, Select, errorMessage, fieldError } from './ui';

export interface WorkspaceFormValues {
  name: string;
  industry: string;
  country: string;
  timezone: string;
  currency: string;
}

export const defaultWorkspaceValues = (): WorkspaceFormValues => ({
  name: '',
  industry: '',
  country: 'IN',
  timezone: browserTimeZone(),
  currency: 'INR',
});

export function WorkspaceForm({
  initial,
  submitLabel,
  disabled = false,
  onSubmit,
}: {
  initial: WorkspaceFormValues;
  submitLabel: string;
  disabled?: boolean;
  onSubmit: (values: WorkspaceFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof WorkspaceFormValues>(key: K, value: WorkspaceFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const isFieldError = error instanceof ApiError && error.code === 'VALIDATION_ERROR';

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error != null && !isFieldError && <Alert>{errorMessage(error)}</Alert>}
      <Field label="Business name" htmlFor="ws-name" error={fieldError(error, 'name')}>
        <Input id="ws-name" required disabled={disabled} value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sharma Dental Clinic" />
      </Field>
      <Field label="Industry" htmlFor="ws-industry" error={fieldError(error, 'industry')}>
        <Select id="ws-industry" disabled={disabled} value={values.industry} onChange={(e) => set('industry', e.target.value)}>
          <option value="">Select an industry</option>
          {INDUSTRIES.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Country" htmlFor="ws-country" error={fieldError(error, 'country')}>
          <Select
            id="ws-country"
            disabled={disabled}
            value={values.country}
            onChange={(e) => {
              const country = COUNTRIES.find((c) => c.code === e.target.value);
              setValues((v) => ({ ...v, country: e.target.value, currency: country?.currency ?? v.currency }));
            }}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default currency" htmlFor="ws-currency" error={fieldError(error, 'currency')}>
          <Select id="ws-currency" disabled={disabled} value={values.currency} onChange={(e) => set('currency', e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Timezone" htmlFor="ws-timezone" error={fieldError(error, 'timezone')} hint="Used for scheduled broadcasts, reminders and quiet hours.">
        <Select id="ws-timezone" disabled={disabled} value={values.timezone} onChange={(e) => set('timezone', e.target.value)}>
          {timeZones(values.timezone).map((tz) => (
            <option key={tz}>{tz}</option>
          ))}
        </Select>
      </Field>
      {!disabled && (
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
      )}
    </form>
  );
}
