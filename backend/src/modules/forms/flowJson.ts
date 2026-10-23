import { z } from 'zod';
import { env } from '../../config/env.js';
import { FIELD_TYPES, type FieldType } from './form.model.js';

/**
 * Builder + compatibility validator for WhatsApp Flows JSON (navigate-only,
 * single screen). Limits below are deliberately conservative versions of
 * Meta's component limits; Meta's own validation errors are surfaced on publish.
 */
export const LIMITS = {
  fields: 20,
  label: 20,
  optionTitle: 30,
  options: 20,
  optInLabel: 120,
};

const option = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,30}$/, 'Option ids use lowercase letters, numbers and underscores.'),
  title: z.string().trim().min(1, 'Name every option.').max(LIMITS.optionTitle, `Option titles are at most ${LIMITS.optionTitle} characters.`),
});

export const fieldInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Field keys start with a letter and use lowercase letters, numbers and underscores.'),
    label: z.string().trim().min(1, 'Every field needs a label.'),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(option).max(LIMITS.options).default([]),
    saveTo: z
      .string()
      .regex(/^(name|email|custom\.[a-z0-9_]{1,40})$/)
      .nullable()
      .default(null),
  })
  .superRefine((f, ctx) => {
    const max = f.type === 'opt_in' ? LIMITS.optInLabel : LIMITS.label;
    if (f.label.length > max) ctx.addIssue({ code: 'custom', path: ['label'], message: `"${f.label}" is longer than ${max} characters (WhatsApp limit).` });
    if (['dropdown', 'radio', 'checkbox'].includes(f.type) && f.options.length < 1) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: `"${f.label}" needs at least one option.` });
    }
    if (new Set(f.options.map((o) => o.id)).size !== f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option ids must be unique.' });
  });

export type FormField = z.infer<typeof fieldInput>;

export function validateFields(fields: FormField[]): string[] {
  const issues: string[] = [];
  if (fields.length === 0) issues.push('Add at least one field.');
  if (fields.length > LIMITS.fields) issues.push(`A form can have at most ${LIMITS.fields} fields.`);
  const keys = new Set<string>();
  for (const f of fields) {
    const parsed = fieldInput.safeParse(f);
    if (!parsed.success) issues.push(parsed.error.issues[0]!.message);
    if (keys.has(f.key)) issues.push(`Two fields use the key "${f.key}".`);
    keys.add(f.key);
  }
  return issues;
}

function component(f: FormField): Record<string, unknown> {
  const base = { name: f.key, label: f.label, required: f.required };
  const inputType: Partial<Record<FieldType, string>> = { short_text: 'text', email: 'email', phone: 'phone', number: 'number' };
  switch (f.type) {
    case 'short_text':
    case 'email':
    case 'phone':
    case 'number':
      return { type: 'TextInput', 'input-type': inputType[f.type], ...base };
    case 'long_text':
      return { type: 'TextArea', ...base };
    case 'dropdown':
      return { type: 'Dropdown', ...base, 'data-source': f.options };
    case 'radio':
      return { type: 'RadioButtonsGroup', ...base, 'data-source': f.options };
    case 'checkbox':
      return { type: 'CheckboxGroup', ...base, 'data-source': f.options };
    case 'date':
      return { type: 'DatePicker', ...base };
    case 'opt_in':
      return { type: 'OptIn', name: f.key, label: f.label, required: f.required };
  }
}

export const FORM_SCREEN_ID = 'FORM';

export function buildFlowJson(form: { screenTitle: string; submitLabel: string; intro: string; fields: FormField[] }) {
  return {
    version: env.META_FLOW_JSON_VERSION,
    screens: [
      {
        id: FORM_SCREEN_ID,
        title: form.screenTitle,
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...form.fields.map(component),
            {
              type: 'Footer',
              label: form.submitLabel,
              'on-click-action': {
                name: 'complete',
                payload: Object.fromEntries(form.fields.map((f) => [f.key, `\${form.${f.key}}`])),
              },
            },
          ],
        },
      },
    ],
  };
}

/** Checks a submission against the published field definitions. */
export function validateSubmission(fields: FormField[], data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of fields) {
    const value = data[f.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (f.required) errors.push(`${f.label} is required.`);
      continue;
    }
    const allowed = new Set(f.options.map((o) => o.id));
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) errors.push(`${f.label} is not a valid email.`);
    if (f.type === 'phone' && String(value).replace(/\D/g, '').length < 8) errors.push(`${f.label} is not a valid phone number.`);
    if (f.type === 'number' && !/^-?\d+([.,]\d+)?$/.test(String(value))) errors.push(`${f.label} is not a number.`);
    if ((f.type === 'dropdown' || f.type === 'radio') && !allowed.has(String(value))) errors.push(`${f.label} has an unknown choice.`);
    if (f.type === 'checkbox' && (!Array.isArray(value) || value.some((v) => !allowed.has(String(v))))) errors.push(`${f.label} has an unknown choice.`);
  }
  return errors;
}

/** Human-readable value (option titles instead of ids). */
export function displayValue(f: FormField, value: unknown): string {
  const title = (id: unknown) => f.options.find((o) => o.id === String(id))?.title ?? String(id);
  if (Array.isArray(value)) return value.map(title).join(', ');
  if (f.type === 'dropdown' || f.type === 'radio') return title(value);
  if (f.type === 'opt_in') return value === true || value === 'true' ? 'Yes' : 'No';
  return value == null ? '' : String(value);
}
