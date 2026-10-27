import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { FORM_SCREEN_ID, validateFields, type FormField } from './flowJson.js';
import type { FieldType } from './form.model.js';

/**
 * Multi-screen forms. Each screen holds text, input, selection, date, media and
 * other elements; screens are joined with a "Continue" footer and the last one
 * submits every answer. Inputs map onto the original FormField shape, so
 * submissions, validation and "copy to contact" work unchanged.
 */

export const COMPONENT_TYPES = [
  'heading',
  'subheading',
  'caption',
  'body',
  'text_input',
  'text_area',
  'single_choice',
  'multi_choice',
  'dropdown',
  'date',
  'image',
  'opt_in',
  'link',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const INPUT_TYPES = ['text', 'email', 'phone', 'number', 'password', 'passcode'] as const;

export const FORM_CATEGORIES = ['SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER'] as const;

const option = z.object({ id: z.string().max(30), title: z.string().max(60) });

/** Loose shape for drafts (saved half-finished); WhatsApp limits are checked on publish. */
export const componentSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(COMPONENT_TYPES),
  key: z.string().max(40).optional(),
  label: z.string().max(200).optional(),
  text: z.string().max(4096).optional(),
  required: z.boolean().optional(),
  inputType: z.enum(INPUT_TYPES).optional(),
  helperText: z.string().max(200).optional(),
  options: z.array(option).max(30).optional(),
  // Image: base64 (no data: prefix), shown at this height.
  image: z.string().max(400_000).optional(),
  height: z.number().int().min(50).max(600).optional(),
  url: z.string().max(2000).optional(),
  saveTo: z.string().max(60).nullable().optional(),
});
export type FormComponent = z.infer<typeof componentSchema>;

export const screenSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(60),
  footerLabel: z.string().max(60).default('Continue'),
  components: z.array(componentSchema).max(50).default([]),
});
export type FormScreen = z.infer<typeof screenSchema>;

export const newId = () => randomBytes(6).toString('hex');

export const INPUT_COMPONENTS: ComponentType[] = ['text_input', 'text_area', 'single_choice', 'multi_choice', 'dropdown', 'date', 'opt_in'];

/** Turns a pre-screens form (one list of fields) into a single screen. */
export function fieldsToScreens(fields: FormField[], title = 'Details', submitLabel = 'Submit'): FormScreen[] {
  const toComponent = (f: FormField): FormComponent => {
    const common = { id: newId(), key: f.key, label: f.label, required: f.required, saveTo: f.saveTo ?? null };
    switch (f.type) {
      case 'long_text':
        return { ...common, type: 'text_area' };
      case 'dropdown':
        return { ...common, type: 'dropdown', options: f.options };
      case 'radio':
        return { ...common, type: 'single_choice', options: f.options };
      case 'checkbox':
        return { ...common, type: 'multi_choice', options: f.options };
      case 'date':
        return { ...common, type: 'date' };
      case 'opt_in':
        return { ...common, type: 'opt_in' };
      default:
        return { ...common, type: 'text_input', inputType: f.type === 'short_text' ? 'text' : f.type };
    }
  };
  return [{ id: newId(), title, footerLabel: submitLabel, components: fields.map(toComponent) }];
}

/** Every answer the form collects, as FormFields (in screen order). */
export function inputsOf(screens: FormScreen[]): FormField[] {
  const fieldType = (c: FormComponent): FieldType => {
    switch (c.type) {
      case 'text_area':
        return 'long_text';
      case 'single_choice':
        return 'radio';
      case 'multi_choice':
        return 'checkbox';
      case 'dropdown':
        return 'dropdown';
      case 'date':
        return 'date';
      case 'opt_in':
        return 'opt_in';
      default:
        return c.inputType === 'email' || c.inputType === 'phone' || c.inputType === 'number' ? c.inputType : 'short_text';
    }
  };
  return screens.flatMap((s) =>
    s.components
      .filter((c) => INPUT_COMPONENTS.includes(c.type))
      .map((c) => ({ key: c.key ?? '', label: c.label ?? '', type: fieldType(c), required: !!c.required, options: c.options ?? [], saveTo: c.saveTo ?? null })),
  );
}

const TEXT_LIMITS: Partial<Record<ComponentType, number>> = { heading: 80, subheading: 80, caption: 409, body: 4096 };
const LABEL_LIMITS: Partial<Record<ComponentType, number>> = { text_input: 20, text_area: 20, dropdown: 20, single_choice: 30, multi_choice: 30, date: 40, opt_in: 120 };

/** WhatsApp limits for a whole form; empty when it can be published. */
export function validateScreens(screens: FormScreen[]): string[] {
  const issues: string[] = [];
  if (!screens.length) issues.push('Add at least one screen.');
  if (screens.length > 10) issues.push('A form can have at most 10 screens.');
  screens.forEach((s, i) => {
    const name = `Screen ${i + 1}`;
    if (!s.title.trim()) issues.push(`${name} needs a title.`);
    if (s.title.length > 30) issues.push(`${name}: the title is longer than 30 characters.`);
    if (!s.footerLabel.trim()) issues.push(`${name} needs a button label.`);
    if (s.footerLabel.length > 35) issues.push(`${name}: the button label is longer than 35 characters.`);
    if (!s.components.length) issues.push(`${name} is empty.`);
    for (const c of s.components) {
      const textMax = TEXT_LIMITS[c.type];
      if (textMax !== undefined) {
        if (!c.text?.trim()) issues.push(`${name}: a text element is empty.`);
        else if (c.text.length > textMax) issues.push(`${name}: "${c.text.slice(0, 20)}…" is longer than ${textMax} characters.`);
      }
      if (c.type === 'image' && !c.image) issues.push(`${name}: add a picture to the image element.`);
      if (c.type === 'link') {
        if (!c.text?.trim() || c.text.length > 25) issues.push(`${name}: link text must be 1–25 characters.`);
        if (!/^https:\/\/\S+$/.test(c.url ?? '')) issues.push(`${name}: links need a full https:// address.`);
      }
      // Labels of input elements follow per-type WhatsApp limits; validateFields uses the 20-char default.
      const labelMax = LABEL_LIMITS[c.type];
      if (labelMax && labelMax > 20 && c.label && c.label.length > labelMax) issues.push(`"${c.label}" is longer than ${labelMax} characters (WhatsApp limit).`);
    }
  });
  const fields = inputsOf(screens);
  if (fields.length) {
    // Reuse the field rules (keys, options, duplicates); widen the label limit where WhatsApp allows more.
    const relaxed = validateFields(fields.map((f) => (f.type === 'radio' || f.type === 'checkbox' || f.type === 'date' ? { ...f, label: f.label.slice(0, 20) } : f)));
    issues.push(...relaxed.filter((m) => m !== 'Add at least one field.'));
  }
  return [...new Set(issues)];
}

const SCREEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Flow JSON screen ids: the first is always FORM (what sends and templates open). */
export const flowScreenId = (index: number) => (index === 0 ? FORM_SCREEN_ID : `SCREEN_${SCREEN_LETTERS[index - 1] ?? 'Z'}`);

function toJson(c: FormComponent): Record<string, unknown> | null {
  const named = { name: c.key, label: c.label, required: !!c.required };
  const helper = c.helperText ? { 'helper-text': c.helperText } : {};
  switch (c.type) {
    case 'heading':
      return { type: 'TextHeading', text: c.text };
    case 'subheading':
      return { type: 'TextSubheading', text: c.text };
    case 'caption':
      return { type: 'TextCaption', text: c.text };
    case 'body':
      return { type: 'TextBody', text: c.text };
    case 'text_input':
      return { type: 'TextInput', 'input-type': c.inputType ?? 'text', ...named, ...helper };
    case 'text_area':
      return { type: 'TextArea', ...named, ...helper };
    case 'single_choice':
      return { type: 'RadioButtonsGroup', ...named, 'data-source': c.options ?? [] };
    case 'multi_choice':
      return { type: 'CheckboxGroup', ...named, 'data-source': c.options ?? [] };
    case 'dropdown':
      return { type: 'Dropdown', ...named, 'data-source': c.options ?? [] };
    case 'date':
      return { type: 'DatePicker', ...named, ...helper };
    case 'opt_in':
      return { type: 'OptIn', name: c.key, label: c.label, required: !!c.required };
    case 'image':
      return { type: 'Image', src: c.image, height: c.height ?? 200, 'scale-type': 'contain', ...(c.label ? { 'alt-text': c.label } : {}) };
    case 'link':
      return { type: 'EmbeddedLink', text: c.text, 'on-click-action': { name: 'open_url', url: c.url } };
  }
}

/** Example values Meta needs for data passed between screens. */
function dataSchema(f: FormField) {
  if (f.type === 'checkbox') return { type: 'array', items: { type: 'string' }, __example__: [f.options[0]?.id ?? 'a'] };
  if (f.type === 'opt_in') return { type: 'boolean', __example__: true };
  return { type: 'string', __example__: f.options[0]?.id ?? 'example' };
}

/**
 * Navigate-only Flow JSON. Answers from earlier screens travel forward as
 * screen data, and the last screen's "complete" returns every answer.
 */
export function buildScreensFlowJson(screens: FormScreen[]) {
  const carried: FormField[] = [];
  return {
    version: env.META_FLOW_JSON_VERSION,
    screens: screens.map((s, i) => {
      const own = inputsOf([s]);
      const last = i === screens.length - 1;
      const payload = Object.fromEntries([...carried.map((f) => [f.key, `\${data.${f.key}}`]), ...own.map((f) => [f.key, `\${form.${f.key}}`])]);
      const screen = {
        id: flowScreenId(i),
        title: s.title,
        ...(last ? { terminal: true, success: true } : {}),
        data: Object.fromEntries(carried.map((f) => [f.key, dataSchema(f)])),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...s.components.map(toJson).filter(Boolean),
            {
              type: 'Footer',
              label: s.footerLabel,
              'on-click-action': last ? { name: 'complete', payload } : { name: 'navigate', next: { type: 'screen', name: flowScreenId(i + 1) }, payload },
            },
          ],
        },
      };
      carried.push(...own);
      return screen;
    }),
  };
}

// ---- Importing Flow JSON ("Paste Flow JSON", Sync) ----

const FROM_JSON: Record<string, ComponentType> = {
  TextHeading: 'heading',
  TextSubheading: 'subheading',
  TextCaption: 'caption',
  TextBody: 'body',
  TextInput: 'text_input',
  TextArea: 'text_area',
  RadioButtonsGroup: 'single_choice',
  CheckboxGroup: 'multi_choice',
  Dropdown: 'dropdown',
  DatePicker: 'date',
  CalendarPicker: 'date',
  OptIn: 'opt_in',
  Image: 'image',
  EmbeddedLink: 'link',
};

type JsonComponent = Record<string, unknown> & { type?: string };

/**
 * Converts Flow JSON to editable screens when it only uses elements the builder
 * supports with static options; otherwise returns null and the JSON is kept as-is.
 */
export function flowJsonToScreens(json: unknown): FormScreen[] | null {
  const screens = (json as { screens?: { id?: string; title?: string; layout?: { children?: JsonComponent[] } }[] })?.screens;
  if (!Array.isArray(screens) || !screens.length) return null;
  const out: FormScreen[] = [];
  for (const s of screens) {
    const children = s.layout?.children ?? [];
    const footer = children.find((c) => c.type === 'Footer');
    const components: FormComponent[] = [];
    for (const c of children) {
      if (c.type === 'Footer') continue;
      const type = c.type ? FROM_JSON[c.type] : undefined;
      if (!type) return null;
      const source = c['data-source'];
      if (source !== undefined && !Array.isArray(source)) return null; // dynamic options need a data endpoint
      const text = typeof c.text === 'string' ? c.text : undefined;
      if ((text ?? (c.label as string) ?? '').includes('${')) return null; // bound to dynamic data
      components.push({
        id: newId(),
        type,
        ...(typeof c.name === 'string' ? { key: c.name } : {}),
        ...(typeof c.label === 'string' ? { label: c.label } : {}),
        ...(text ? { text } : {}),
        ...(typeof c.required === 'boolean' ? { required: c.required } : {}),
        ...(type === 'text_input' ? { inputType: (INPUT_TYPES as readonly string[]).includes(c['input-type'] as string) ? (c['input-type'] as (typeof INPUT_TYPES)[number]) : 'text' } : {}),
        ...(typeof c['helper-text'] === 'string' ? { helperText: c['helper-text'] } : {}),
        ...(Array.isArray(source) ? { options: (source as { id?: string; title?: string }[]).map((o) => ({ id: String(o.id ?? ''), title: String(o.title ?? '') })) } : {}),
        ...(type === 'image' && typeof c.src === 'string' ? { image: c.src, height: typeof c.height === 'number' ? c.height : 200 } : {}),
        ...(type === 'link' ? { url: String((c['on-click-action'] as { url?: string } | undefined)?.url ?? '') } : {}),
        saveTo: null,
      });
    }
    out.push({ id: newId(), title: s.title ?? 'Screen', footerLabel: typeof footer?.label === 'string' ? footer.label : 'Continue', components });
  }
  return out;
}

/** Answers declared in any Flow JSON (for raw / imported forms): every named input. */
export function fieldsFromFlowJson(json: unknown): FormField[] {
  const screens = (json as { screens?: { layout?: { children?: JsonComponent[] } }[] })?.screens ?? [];
  const fields: FormField[] = [];
  const walk = (items: JsonComponent[]) => {
    for (const c of items) {
      if (typeof c.name === 'string' && c.type && c.type !== 'Footer' && !fields.some((f) => f.key === c.name)) {
        const t = FROM_JSON[c.type];
        const source = Array.isArray(c['data-source']) ? (c['data-source'] as { id?: string; title?: string }[]).map((o) => ({ id: String(o.id ?? ''), title: String(o.title ?? '') })) : [];
        const type: FieldType =
          t === 'text_area' ? 'long_text' : t === 'single_choice' ? 'radio' : t === 'multi_choice' ? 'checkbox' : t === 'dropdown' ? 'dropdown' : t === 'date' ? 'date' : t === 'opt_in' ? 'opt_in' : c['input-type'] === 'email' ? 'email' : c['input-type'] === 'phone' ? 'phone' : c['input-type'] === 'number' ? 'number' : 'short_text';
        fields.push({ key: c.name, label: typeof c.label === 'string' ? c.label : c.name, type, required: false, options: source, saveTo: null });
      }
      for (const v of Object.values(c)) if (Array.isArray(v) && v.length && typeof v[0] === 'object' && (v[0] as JsonComponent)?.type) walk(v as JsonComponent[]);
    }
  };
  for (const s of screens) walk(s.layout?.children ?? []);
  return fields;
}
