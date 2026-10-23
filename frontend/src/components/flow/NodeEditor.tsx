import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { FlowGraphNode, Member, MessageTemplate, Tag, VariableSpec } from '../../lib/api';
import { STAGES } from '../crm';
import { TemplatePreview } from '../TemplatePreview';
import { Button, Field, Input, Select } from '../ui';
import { VariableRow } from '../VariableRow';
import { NODE_META } from './meta';

type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const uid = () => Math.random().toString(36).slice(2, 8);
const textarea =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none disabled:bg-slate-100';

const PLACEHOLDERS = ['{{contact.first_name}}', '{{contact.name}}', '{{contact.phone}}', '{{last_reply}}'];

export interface EditorDeps {
  tags: Tag[];
  templates: MessageTemplate[];
  members: Member[] | undefined;
}

/** Right-hand panel: edits the selected step's config. */
export function NodeEditor({
  node,
  deps,
  disabled,
  onChange,
  onDelete,
  onClose,
}: {
  node: FlowGraphNode;
  deps: EditorDeps;
  disabled: boolean;
  onChange: (data: Data) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const meta = NODE_META[node.type];
  const d = node.data as Data;
  const set = (patch: Data) => onChange({ ...d, ...patch });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <meta.icon className="size-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-ink">{meta.label}</h3>
        <button onClick={onClose} className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close panel">
          <X className="size-4" />
        </button>
      </div>
      <fieldset disabled={disabled} className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <p className="text-xs text-slate-500">{meta.description}</p>
        {node.type === 'trigger' && <TriggerForm d={d} set={set} tags={deps.tags} />}
        {node.type === 'send_text' && (
          <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
        )}
        {node.type === 'send_template' && <TemplateForm d={d} set={set} templates={deps.templates} />}
        {node.type === 'send_buttons' && <ButtonsForm d={d} set={set} />}
        {node.type === 'send_cta' && (
          <>
            <Field label="Header (optional)" htmlFor="cta-h">
              <Input id="cta-h" maxLength={60} value={d.header ?? ''} onChange={(e) => set({ header: e.target.value })} />
            </Field>
            <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
            <Field label="Footer (optional)" htmlFor="cta-f">
              <Input id="cta-f" maxLength={60} value={d.footer ?? ''} onChange={(e) => set({ footer: e.target.value })} />
            </Field>
            <Field label="Button text" htmlFor="cta-b" hint="Up to 20 characters.">
              <Input id="cta-b" maxLength={20} value={d.buttonText ?? ''} onChange={(e) => set({ buttonText: e.target.value })} />
            </Field>
            <Field label="Link" htmlFor="cta-u" hint="Must start with https://">
              <Input id="cta-u" type="url" value={d.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          </>
        )}
        {node.type === 'ask' && <AskForm d={d} set={set} />}
        {node.type === 'condition' && <ConditionForm d={d} set={set} tags={deps.tags} />}
        {node.type === 'delay' && (
          <div className="flex gap-2">
            <Input aria-label="Amount" type="number" min={1} value={d.amount ?? 1} onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })} />
            <Select aria-label="Unit" value={d.unit ?? 'hours'} onChange={(e) => set({ unit: e.target.value })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
          </div>
        )}
        {node.type === 'update_contact' && <UpdateForm d={d} set={set} tags={deps.tags} />}
        {node.type === 'handoff' && (
          <>
            <Field label="Assign to" htmlFor="ho-a" hint={deps.members ? undefined : 'Only managers can see the team list.'}>
              <Select id="ho-a" value={d.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value || null })}>
                <option value="">Team queue (unassigned)</option>
                {deps.members
                  ?.filter((m) => m.role !== 'analyst')
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <MessageText label="Message to the customer (optional)" value={d.message ?? ''} onChange={(message) => set({ message })} />
            <Field label="Internal note for the team (optional)" htmlFor="ho-n">
              <textarea id="ho-n" rows={2} className={textarea} value={d.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
            </Field>
            <p className="text-xs text-slate-500">Automations stay paused for this conversation until a teammate resolves it.</p>
          </>
        )}
        {node.type === 'exit' && (
          <Field label="Goal name (optional)" htmlFor="ex-g" hint="Counted as a conversion in the runs list, e.g. booked_appointment.">
            <Input id="ex-g" maxLength={80} value={d.goal ?? ''} onChange={(e) => set({ goal: e.target.value })} />
          </Field>
        )}
      </fieldset>
      {node.type !== 'trigger' && !disabled && (
        <div className="border-t border-slate-200 p-3">
          <Button variant="danger" className="w-full" onClick={onDelete}>
            <Trash2 className="size-4" /> Delete step
          </Button>
        </div>
      )}
    </div>
  );
}

function MessageText({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      <textarea rows={4} className={textarea} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      <div className="flex flex-wrap gap-1">
        {PLACEHOLDERS.map((p) => (
          <button key={p} type="button" onClick={() => onChange(`${value ?? ''}${p}`)} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-slate-200">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function TriggerForm({ d, set, tags }: { d: Data; set: (p: Data) => void; tags: Tag[] }) {
  const [keywordText, setKeywordText] = useState((d.keywords ?? []).join(', '));
  useEffect(() => setKeywordText((d.keywords ?? []).join(', ')), [d.keywords]);
  return (
    <>
      <Field label="Start when" htmlFor="tr-e">
        <Select id="tr-e" value={d.event} onChange={(e) => set({ event: e.target.value })}>
          <option value="keyword">A customer sends a keyword</option>
          <option value="any_message">Any customer message (fallback)</option>
          <option value="new_contact">A new contact messages for the first time</option>
          <option value="tag_added">A tag is added to a contact</option>
        </Select>
      </Field>
      {d.event === 'keyword' && (
        <>
          <Field label="Keywords" htmlFor="tr-k" hint="Separate with commas, e.g. review, feedback">
            <Input
              id="tr-k"
              value={keywordText}
              onChange={(e) => setKeywordText(e.target.value)}
              onBlur={() => set({ keywords: keywordText.split(',').map((k: string) => k.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="Match" htmlFor="tr-m">
            <Select id="tr-m" value={d.match ?? 'exact'} onChange={(e) => set({ match: e.target.value })}>
              <option value="exact">Message is exactly the keyword</option>
              <option value="contains">Message contains the keyword</option>
            </Select>
          </Field>
        </>
      )}
      {d.event === 'tag_added' && (
        <Field label="Tag" htmlFor="tr-t">
          <Select id="tr-t" value={d.tagId ?? ''} onChange={(e) => set({ tagId: e.target.value || null })}>
            <option value="">Choose a tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(d.event === 'tag_added' || d.event === 'new_contact') && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          {d.event === 'tag_added' ? 'The contact may not have messaged in the last 24 hours: start with a template message.' : 'Runs only on the very first message from a number.'}
        </p>
      )}
    </>
  );
}

function TemplateForm({ d, set, templates }: { d: Data; set: (p: Data) => void; templates: MessageTemplate[] }) {
  const template = templates.find((t) => t.id === d.templateId);
  const fit = (list: VariableSpec[] = [], n: number) =>
    Array.from({ length: n }, (_, i) => list[i] ?? { source: 'field' as const, value: 'first_name', fallback: 'there' });
  return (
    <>
      <Field label="Approved template" htmlFor="tp-t">
        <Select
          id="tp-t"
          value={d.templateId ?? ''}
          onChange={(e) => {
            const t = templates.find((x) => x.id === e.target.value);
            set({ templateId: e.target.value, headerVariables: fit([], t?.variables.header ?? 0), bodyVariables: fit([], t?.variables.body ?? 0) });
          }}
        >
          <option value="">{templates.length ? 'Choose a template' : 'No approved templates'}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </Select>
      </Field>
      {template && (
        <>
          {(d.headerVariables ?? []).map((v: VariableSpec, i: number) => (
            <VariableRow key={`h${i}`} label={`Header {{${i + 1}}}`} spec={v} disabled={false} onChange={(spec) => set({ headerVariables: d.headerVariables.map((x: VariableSpec, j: number) => (j === i ? spec : x)) })} />
          ))}
          {(d.bodyVariables ?? []).map((v: VariableSpec, i: number) => (
            <VariableRow key={`b${i}`} label={`Body {{${i + 1}}}`} spec={v} disabled={false} onChange={(spec) => set({ bodyVariables: d.bodyVariables.map((x: VariableSpec, j: number) => (j === i ? spec : x)) })} />
          ))}
          <TemplatePreview components={template.components} />
        </>
      )}
    </>
  );
}

function ButtonsForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const buttons: { id: string; title: string }[] = d.buttons ?? [];
  return (
    <>
      <Field label="Header (optional)" htmlFor="bt-h">
        <Input id="bt-h" maxLength={60} value={d.header ?? ''} onChange={(e) => set({ header: e.target.value })} />
      </Field>
      <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
      <Field label="Footer (optional)" htmlFor="bt-f">
        <Input id="bt-f" maxLength={60} value={d.footer ?? ''} onChange={(e) => set({ footer: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700">Buttons (each one gets its own path)</p>
        {buttons.map((b, i) => (
          <div key={b.id} className="flex gap-2">
            <Input aria-label={`Button ${i + 1}`} maxLength={20} value={b.title} onChange={(e) => set({ buttons: buttons.map((x) => (x.id === b.id ? { ...x, title: e.target.value } : x)) })} />
            <button type="button" onClick={() => set({ buttons: buttons.filter((x) => x.id !== b.id) })} className="rounded p-2 text-slate-400 hover:text-red-600" aria-label="Remove button">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {buttons.length < 3 && (
          <button type="button" onClick={() => set({ buttons: [...buttons, { id: uid(), title: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Plus className="size-3" /> Add button
          </button>
        )}
      </div>
      <Timeout d={d} set={set} />
    </>
  );
}

function AskForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const target = String(d.saveTo ?? 'custom.answer');
  const kind = target === 'name' || target === 'email' ? target : target.startsWith('var.') ? 'var' : 'custom';
  const key = kind === 'custom' || kind === 'var' ? target.split('.')[1] ?? '' : '';
  return (
    <>
      <MessageText label="Question" value={d.question} onChange={(question) => set({ question })} />
      <Field label="Save the answer to" htmlFor="ask-s">
        <div className="flex gap-2">
          <Select
            id="ask-s"
            value={kind}
            onChange={(e) => {
              const k = e.target.value;
              set({ saveTo: k === 'name' || k === 'email' ? k : `${k}.${key || 'answer'}` });
            }}
          >
            <option value="name">Contact name</option>
            <option value="email">Contact email</option>
            <option value="custom">Contact custom field</option>
            <option value="var">Flow variable (this run only)</option>
          </Select>
          {(kind === 'custom' || kind === 'var') && (
            <Input aria-label="Field key" value={key} onChange={(e) => set({ saveTo: `${kind}.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` })} />
          )}
        </div>
      </Field>
      <Field label="Expected answer" htmlFor="ask-v">
        <Select id="ask-v" value={d.validation ?? 'any'} onChange={(e) => set({ validation: e.target.value })}>
          <option value="any">Any text</option>
          <option value="email">Email address</option>
          <option value="number">Number</option>
          <option value="phone">Phone number</option>
        </Select>
      </Field>
      {d.validation && d.validation !== 'any' && (
        <Field label="If the answer is invalid, reply" htmlFor="ask-r">
          <Input id="ask-r" value={d.retryMessage ?? ''} onChange={(e) => set({ retryMessage: e.target.value })} />
        </Field>
      )}
      <Timeout d={d} set={set} />
    </>
  );
}

function Timeout({ d, set }: { d: Data; set: (p: Data) => void }) {
  return (
    <Field label="Wait for a reply up to (minutes)" htmlFor="to-m" hint='After this, the flow follows "No reply".'>
      <Input id="to-m" type="number" min={1} value={d.timeoutMinutes ?? 1440} onChange={(e) => set({ timeoutMinutes: Math.max(1, Number(e.target.value) || 1) })} />
    </Field>
  );
}

const CONDITION_FIELDS = [
  { value: 'last_reply', label: 'Last reply' },
  { value: 'tag', label: 'Tag' },
  { value: 'stage', label: 'Lifecycle stage' },
  { value: 'consent', label: 'Consent' },
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'custom', label: 'Custom field' },
  { value: 'var', label: 'Flow variable' },
];

function ConditionForm({ d, set, tags }: { d: Data; set: (p: Data) => void; tags: Tag[] }) {
  const rules: { field: string; op: string; value: string }[] = d.rules ?? [];
  const update = (i: number, patch: Partial<(typeof rules)[number]>) => set({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <Field label="Go down “Yes” when" htmlFor="cd-m">
        <Select id="cd-m" value={d.match ?? 'all'} onChange={(e) => set({ match: e.target.value })}>
          <option value="all">All rules match</option>
          <option value="any">Any rule matches</option>
        </Select>
      </Field>
      {rules.map((r, i) => {
        const base = r.field.includes('.') ? r.field.split('.')[0]! : r.field;
        return (
          <RuleBox key={i} onRemove={rules.length > 1 ? () => set({ rules: rules.filter((_, j) => j !== i) }) : undefined}>
            <Select aria-label="Field" value={base} onChange={(e) => {
              const f = e.target.value;
              update(i, { field: f === 'custom' || f === 'var' ? `${f}.field` : f, op: f === 'tag' ? 'has' : 'equals', value: '' });
            }}>
              {CONDITION_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            {(base === 'custom' || base === 'var') && (
              <Input aria-label="Field key" value={r.field.split('.')[1] ?? ''} onChange={(e) => update(i, { field: `${base}.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` })} />
            )}
            <Select aria-label="Operator" value={r.op} onChange={(e) => update(i, { op: e.target.value })}>
              {base === 'tag' ? (
                <>
                  <option value="has">has tag</option>
                  <option value="not_has">doesn&apos;t have tag</option>
                </>
              ) : (
                <>
                  <option value="equals">is</option>
                  <option value="not_equals">is not</option>
                  <option value="contains">contains</option>
                  <option value="is_empty">is empty</option>
                  <option value="not_empty">is not empty</option>
                </>
              )}
            </Select>
            {base === 'tag' ? (
              <Select aria-label="Tag" value={r.value} onChange={(e) => update(i, { value: e.target.value })}>
                <option value="">Choose a tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            ) : base === 'stage' ? (
              <Select aria-label="Stage" value={r.value} onChange={(e) => update(i, { value: e.target.value })}>
                {STAGES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            ) : base === 'consent' ? (
              <Select aria-label="Consent" value={r.value} onChange={(e) => update(i, { value: e.target.value })}>
                <option value="opted_in">Opted in</option>
                <option value="unknown">Unknown</option>
              </Select>
            ) : (
              !['is_empty', 'not_empty'].includes(r.op) && <Input aria-label="Value" value={r.value} onChange={(e) => update(i, { value: e.target.value })} />
            )}
          </RuleBox>
        );
      })}
      {rules.length < 10 && (
        <button type="button" onClick={() => set({ rules: [...rules, { field: 'last_reply', op: 'contains', value: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus className="size-3" /> Add rule
        </button>
      )}
    </>
  );
}

function UpdateForm({ d, set, tags }: { d: Data; set: (p: Data) => void; tags: Tag[] }) {
  const actions: Data[] = d.actions ?? [];
  const update = (i: number, next: Data) => set({ actions: actions.map((a, j) => (j === i ? next : a)) });
  return (
    <>
      {actions.map((a, i) => (
        <RuleBox key={i} onRemove={actions.length > 1 ? () => set({ actions: actions.filter((_, j) => j !== i) }) : undefined}>
          <Select aria-label="Change" value={a.type} onChange={(e) => {
            const t = e.target.value;
            update(i, t === 'set_stage' ? { type: t, stage: 'contacted' } : t === 'set_field' ? { type: t, field: 'custom.field', value: '' } : { type: t, tagId: '' });
          }}>
            <option value="add_tag">Add tag</option>
            <option value="remove_tag">Remove tag</option>
            <option value="set_stage">Set lifecycle stage</option>
            <option value="set_field">Set field</option>
          </Select>
          {(a.type === 'add_tag' || a.type === 'remove_tag') && (
            <Select aria-label="Tag" value={a.tagId ?? ''} onChange={(e) => update(i, { ...a, tagId: e.target.value })}>
              <option value="">Choose a tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
          {a.type === 'set_stage' && (
            <Select aria-label="Stage" value={a.stage} onChange={(e) => update(i, { ...a, stage: e.target.value })}>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
          {a.type === 'set_field' && (
            <>
              <Select aria-label="Field" value={a.field === 'name' || a.field === 'email' ? a.field : 'custom'} onChange={(e) => update(i, { ...a, field: e.target.value === 'custom' ? 'custom.field' : e.target.value })}>
                <option value="name">Name</option>
                <option value="email">Email</option>
                <option value="custom">Custom field</option>
              </Select>
              {String(a.field).startsWith('custom.') && (
                <Input aria-label="Field key" value={String(a.field).slice(7)} onChange={(e) => update(i, { ...a, field: `custom.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` })} />
              )}
              <Input aria-label="Value" placeholder="Value or {{last_reply}}" value={a.value ?? ''} onChange={(e) => update(i, { ...a, value: e.target.value })} />
            </>
          )}
        </RuleBox>
      ))}
      {actions.length < 10 && (
        <button type="button" onClick={() => set({ actions: [...actions, { type: 'add_tag', tagId: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus className="size-3" /> Add change
        </button>
      )}
    </>
  );
}

function RuleBox({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <div className="relative space-y-2 rounded-lg border border-slate-200 p-3 pr-9">
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="absolute top-2 right-2 rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove">
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}
