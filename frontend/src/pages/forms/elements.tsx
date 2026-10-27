import {
  BadgeCheck,
  CalendarDays,
  CircleDot,
  Heading1,
  Heading2,
  Image,
  Link2,
  ListChecks,
  NotepadText,
  SquareChevronDown,
  TextAlignStart,
  TextCursorInput,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { FormComponent, FormComponentType, FormScreen } from '../../lib/api';
import { cn } from '../../components/ui';

export interface PaletteItem {
  type: FormComponentType;
  label: string;
  icon: LucideIcon;
}

/** The builder's left sidebar, grouped like WhatsApp's own Flow components. */
export const PALETTE_GROUPS: { title: string; items: PaletteItem[] }[] = [
  {
    title: 'Text Elements',
    items: [
      { type: 'heading', label: 'Heading', icon: Heading1 },
      { type: 'subheading', label: 'Sub-heading', icon: Heading2 },
      { type: 'caption', label: 'Caption', icon: Type },
      { type: 'body', label: 'Body', icon: TextAlignStart },
    ],
  },
  {
    title: 'Input Elements',
    items: [
      { type: 'text_input', label: 'Input', icon: TextCursorInput },
      { type: 'text_area', label: 'Textarea', icon: NotepadText },
    ],
  },
  {
    title: 'Selection Elements',
    items: [
      { type: 'single_choice', label: 'Single Choice', icon: CircleDot },
      { type: 'multi_choice', label: 'Multi Choice', icon: ListChecks },
      { type: 'dropdown', label: 'Dropdown', icon: SquareChevronDown },
    ],
  },
  { title: 'Date Elements', items: [{ type: 'date', label: 'Date Picker', icon: CalendarDays }] },
  { title: 'Media Elements', items: [{ type: 'image', label: 'Image', icon: Image }] },
  {
    title: 'Other Elements',
    items: [
      { type: 'opt_in', label: 'Opt-in', icon: BadgeCheck },
      { type: 'link', label: 'Link', icon: Link2 },
    ],
  },
];

export const ELEMENT: Record<FormComponentType, PaletteItem> = Object.fromEntries(PALETTE_GROUPS.flatMap((g) => g.items).map((i) => [i.type, i])) as Record<FormComponentType, PaletteItem>;

/** WhatsApp limits, mirrored from the server's publish checks. */
export const TEXT_LIMITS: Partial<Record<FormComponentType, number>> = { heading: 80, subheading: 80, caption: 409, body: 4096, link: 25 };
export const LABEL_LIMITS: Partial<Record<FormComponentType, number>> = { text_input: 20, text_area: 20, dropdown: 20, single_choice: 30, multi_choice: 30, date: 40, opt_in: 120 };
export const INPUT_TYPES: FormComponentType[] = ['text_input', 'text_area', 'single_choice', 'multi_choice', 'dropdown', 'date', 'opt_in'];
export const HAS_OPTIONS = new Set<FormComponentType>(['single_choice', 'multi_choice', 'dropdown']);
export const MAX_SCREENS = 10;

export const uid = () => Math.random().toString(36).slice(2, 12);
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 30);

export const keysOf = (screens: FormScreen[]) => new Set(screens.flatMap((s) => s.components.map((c) => c.key).filter(Boolean) as string[]));

/** A key not used anywhere in the form: `base`, `base_2`, ... */
export function uniqueKey(base: string, taken: Set<string>) {
  const root = base || 'field';
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) if (!taken.has(`${root.slice(0, 26)}_${n}`)) return `${root.slice(0, 26)}_${n}`;
}

const options = (...titles: string[]) => titles.map((title) => ({ id: slug(title), title }));

/** A fresh element with sensible defaults, its answer key unique across the form. */
export function newComponent(type: FormComponentType, screens: FormScreen[]): FormComponent {
  const id = uid();
  const field = (label: string, extra: Partial<FormComponent> = {}): FormComponent => ({ id, type, label, key: uniqueKey(slug(label), keysOf(screens)), required: false, ...extra });
  switch (type) {
    case 'heading':
      return { id, type, text: 'Heading' };
    case 'subheading':
      return { id, type, text: 'Sub-heading' };
    case 'caption':
      return { id, type, text: 'Caption text' };
    case 'body':
      return { id, type, text: 'Body text' };
    case 'text_input':
      return field('Your answer', { inputType: 'text' });
    case 'text_area':
      return field('Message');
    case 'single_choice':
      return field('Choose one', { options: options('Option 1', 'Option 2') });
    case 'multi_choice':
      return field('Choose all that apply', { options: options('Option 1', 'Option 2') });
    case 'dropdown':
      return field('Select an option', { options: options('Option 1', 'Option 2') });
    case 'date':
      return field('Date');
    case 'opt_in':
      return field('I agree to be contacted on WhatsApp');
    case 'image':
      return { id, type, image: '', height: 160 };
    case 'link':
      return { id, type, text: 'Learn more', url: 'https://' };
  }
}

export type Answers = Record<string, string | string[] | boolean>;

const box = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700';

/**
 * Draws one element roughly the way WhatsApp shows it. In the canvas it is
 * inert; the preview passes answers and onChange so it can be filled in.
 */
export function ElementView({ c, answers, onChange }: { c: FormComponent; answers?: Answers; onChange?: (key: string, value: string | string[] | boolean) => void }) {
  const live = !!onChange;
  const key = c.key ?? c.id;
  const value = answers?.[key];
  const set = (v: string | string[] | boolean) => onChange?.(key, v);
  const label = (
    <span className="mb-1 block text-xs text-slate-500">
      {c.label || 'Label'}
      {!c.required && ' (optional)'}
    </span>
  );
  const helper = c.helperText && <span className="mt-1 block text-[11px] text-slate-400">{c.helperText}</span>;
  switch (c.type) {
    case 'heading':
      return <p className="text-lg leading-snug font-bold break-words text-slate-900">{c.text || 'Heading'}</p>;
    case 'subheading':
      return <p className="text-base font-semibold break-words text-slate-800">{c.text || 'Sub-heading'}</p>;
    case 'caption':
      return <p className="text-xs break-words whitespace-pre-line text-slate-500">{c.text || 'Caption'}</p>;
    case 'body':
      return <p className="text-sm break-words whitespace-pre-line text-slate-700">{c.text || 'Body'}</p>;
    case 'text_input':
      return (
        <label className="block">
          {label}
          <input
            className={box}
            readOnly={!live}
            tabIndex={live ? undefined : -1}
            type={c.inputType === 'password' || c.inputType === 'passcode' ? 'password' : c.inputType === 'number' ? 'number' : c.inputType === 'email' ? 'email' : c.inputType === 'phone' ? 'tel' : 'text'}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => set(e.target.value)}
          />
          {helper}
        </label>
      );
    case 'text_area':
      return (
        <label className="block">
          {label}
          <textarea className={cn(box, 'resize-none')} rows={3} readOnly={!live} tabIndex={live ? undefined : -1} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)} />
          {helper}
        </label>
      );
    case 'single_choice':
    case 'multi_choice': {
      const multi = c.type === 'multi_choice';
      const picked = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      return (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-800">
            {c.label || 'Label'}
            {!c.required && <span className="font-normal text-slate-400"> (optional)</span>}
          </legend>
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {(c.options ?? []).map((o) => (
              <label key={o.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-slate-700">
                {o.title || 'Option'}
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`${c.id}-choice`}
                  className="accent-emerald-600"
                  disabled={!live}
                  checked={picked.includes(o.id)}
                  onChange={(e) => set(multi ? (e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id)) : o.id)}
                />
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case 'dropdown':
      return (
        <label className="block">
          {label}
          <select className={box} disabled={!live} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)}>
            <option value="">Select</option>
            {(c.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </label>
      );
    case 'date':
      return (
        <label className="block">
          {label}
          <input type="date" className={box} readOnly={!live} tabIndex={live ? undefined : -1} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)} />
          {helper}
        </label>
      );
    case 'opt_in':
      return (
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 accent-emerald-600" disabled={!live} checked={value === true} onChange={(e) => set(e.target.checked)} />
          <span>
            {c.label || 'Opt-in'}
            {!c.required && <span className="text-slate-400"> (optional)</span>}
          </span>
        </label>
      );
    case 'image':
      return c.image ? (
        <img src={`data:image/png;base64,${c.image}`} alt="" style={{ height: c.height ?? 160 }} className="w-full rounded-lg object-contain" />
      ) : (
        <div style={{ height: Math.min(c.height ?? 160, 160) }} className="flex w-full items-center justify-center rounded-lg border-2 border-dashed border-slate-200 text-xs text-slate-400">
          <Image className="mr-1.5 size-4" /> Upload an image
        </div>
      );
    case 'link':
      return (
        <a href={live && c.url ? c.url : undefined} target="_blank" rel="noreferrer" className="text-sm font-medium text-sky-600 underline-offset-2 hover:underline">
          {c.text || 'Link'}
        </a>
      );
  }
}
