import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { FlowGraphNode, Member, MessageTemplate, Tag, TemplateExtras, VariableSpec, WaForm } from '../../lib/api';
import { useStageOptions } from '../crm';
import { TemplatePreview } from '../TemplatePreview';
import { TemplateExtrasFields, emptyExtras, extrasPreview } from '../TemplateSendFields';
import { Button, Field, Input, Select } from '../ui';
import { VariableRow } from '../VariableRow';
import { NODE_META, WEEKDAYS } from './meta';

type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const uid = () => Math.random().toString(36).slice(2, 8);
const textarea =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none disabled:bg-slate-100';

const PLACEHOLDERS = ['{{contact.first_name}}', '{{contact.name}}', '{{contact.phone}}', '{{last_reply}}'];

export interface EditorDeps {
  tags: Tag[];
  templates: MessageTemplate[];
  members: Member[] | undefined;
  forms: WaForm[];
  googleAccounts: { id: string; email: string }[];
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
        {node.type === 'trigger' && <TriggerForm d={d} set={set} tags={deps.tags} forms={deps.forms} />}
        {node.type === 'send_form' && (
          <>
            <Field label="Form" htmlFor="sf-f" hint={deps.forms.some((f) => f.status === 'published') ? undefined : 'Publish a form on the Forms page first.'}>
              <Select id="sf-f" value={d.formId ?? ''} onChange={(e) => set({ formId: e.target.value })}>
                <option value="">Choose a published form</option>
                {deps.forms
                  .filter((f) => f.status === 'published')
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <MessageText label="Message with the button (optional)" value={d.text ?? ''} onChange={(text) => set({ text })} />
            <Timeout d={d} set={set} />
            <p className="text-xs text-slate-500">
              Answers are available as {'{{vars.form_<field key>}}'} after &ldquo;Submitted&rdquo;.
            </p>
          </>
        )}
        {node.type === 'ai_answer' && (
          <>
            <p className="rounded-lg bg-fuchsia-50 p-2 text-xs text-fuchsia-800">
              Answers the customer&apos;s latest message using the AI Agent&apos;s knowledge base. If the AI isn&apos;t sure, the flow follows &ldquo;Needs human&rdquo;.
            </p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={d.sendAnswer !== false} onChange={(e) => set({ sendAnswer: e.target.checked })} />
              Send the answer to the customer
            </label>
            <p className="text-xs text-slate-500">
              The answer is also saved as {'{{vars.ai_answer}}'} and the reason as {'{{vars.ai_reason}}'}.
            </p>
          </>
        )}
        {node.type === 'http_request' && <HttpForm d={d} set={set} />}
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
        {node.type === 'send_list' && <ListForm d={d} set={set} />}
        {node.type === 'send_media' && <MediaForm d={d} set={set} />}
        {node.type === 'send_location' && (
          <>
            <div className="flex gap-2">
              <Field label="Latitude" htmlFor="loc-lat">
                <Input id="loc-lat" type="number" step="any" value={d.latitude ?? ''} placeholder="28.6139" onChange={(e) => set({ latitude: e.target.value === '' ? null : Number(e.target.value) })} />
              </Field>
              <Field label="Longitude" htmlFor="loc-lng">
                <Input id="loc-lng" type="number" step="any" value={d.longitude ?? ''} placeholder="77.2090" onChange={(e) => set({ longitude: e.target.value === '' ? null : Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Place name (optional)" htmlFor="loc-n">
              <Input id="loc-n" maxLength={100} value={d.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Address (optional)" htmlFor="loc-a">
              <Input id="loc-a" maxLength={300} value={d.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <p className="text-xs text-slate-500">In Google Maps, right-click the place to copy its latitude and longitude.</p>
          </>
        )}
        {node.type === 'send_contacts' && <ContactsForm d={d} set={set} />}
        {node.type === 'send_catalog' && (
          <>
            <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
            <Field label="Footer (optional)" htmlFor="cat-f">
              <Input id="cat-f" maxLength={60} value={d.footer ?? ''} onChange={(e) => set({ footer: e.target.value })} />
            </Field>
            <Field label="Thumbnail product ID (optional)" htmlFor="cat-p" hint="The product's retailer ID. Empty uses the first catalogue item.">
              <Input id="cat-p" maxLength={100} value={d.thumbnailProductId ?? ''} onChange={(e) => set({ thumbnailProductId: e.target.value })} />
            </Field>
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">Needs a catalogue connected to your WhatsApp number in Meta Commerce Manager.</p>
          </>
        )}
        {node.type === 'rating' && (
          <>
            <MessageText label="Question" value={d.question} onChange={(question) => set({ question })} />
            <Field label="Save the rating as" htmlFor="rt-s" hint={`Available later as {{vars.${d.saveAs || 'rating'}}} (1 to 5).`}>
              <Input id="rt-s" value={d.saveAs ?? 'rating'} onChange={(e) => set({ saveAs: slug(e.target.value) })} />
            </Field>
            <Timeout d={d} set={set} />
          </>
        )}
        {node.type === 'ask_address' && (
          <>
            <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
            <Field label="Country" htmlFor="ad-c" hint="WhatsApp's address form is available for India and Singapore numbers.">
              <Select id="ad-c" value={d.country ?? 'IN'} onChange={(e) => set({ country: e.target.value })}>
                <option value="IN">India</option>
                <option value="SG">Singapore</option>
              </Select>
            </Field>
            <Timeout d={d} set={set} />
            <p className="text-xs text-slate-500">The full address is saved as {'{{vars.address}}'}. A typed address is accepted too.</p>
          </>
        )}
        {node.type === 'wait_reply' && (
          <>
            <Field label="Wait for a reply for" htmlFor="wr-a">
              <AmountUnit id="wr-a" d={d} set={set} />
            </Field>
            <p className="text-xs text-slate-500">
              Put this after a message. If the customer replies in time the flow follows &ldquo;Replied&rdquo;; otherwise &ldquo;No reply&rdquo;, where you can send a reminder. Chain several for a follow-up sequence.
            </p>
          </>
        )}
        {node.type === 'time_check' && (
          <>
            <DayPicker label="Working days" value={d.days ?? []} onChange={(days) => set({ days })} />
            <div className="flex gap-2">
              <Field label="From" htmlFor="tc-f">
                <Input id="tc-f" type="time" value={d.from ?? '09:00'} onChange={(e) => set({ from: e.target.value })} />
              </Field>
              <Field label="To" htmlFor="tc-t">
                <Input id="tc-t" type="time" value={d.to ?? '18:00'} onChange={(e) => set({ to: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-slate-500">Uses your workspace timezone. An end time before the start time runs overnight.</p>
          </>
        )}
        {node.type === 'add_tags' && (
          <div className="space-y-1.5">
            <p className="font-medium text-slate-700">Tags to add</p>
            {deps.tags.length === 0 && <p className="text-xs text-slate-500">Create tags on the Contacts page first.</p>}
            <div className="flex flex-wrap gap-1.5">
              {deps.tags.map((t) => {
                const on = (d.tagIds ?? []).includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set({ tagIds: on ? d.tagIds.filter((x: string) => x !== t.id) : [...(d.tagIds ?? []), t.id] })}
                    className={on ? 'rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white' : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200'}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {node.type === 'set_stage' && <StageForm d={d} set={set} />}
        {node.type === 'set_field' && (
          <>
            <Field label="Field" htmlFor="sf-k">
              <div className="flex gap-2">
                <Select id="sf-k" value={d.field === 'name' || d.field === 'email' ? d.field : 'custom'} onChange={(e) => set({ field: e.target.value === 'custom' ? 'custom.field' : e.target.value })}>
                  <option value="name">Name</option>
                  <option value="email">Email</option>
                  <option value="custom">Custom field</option>
                </Select>
                {String(d.field ?? '').startsWith('custom.') && <Input aria-label="Field key" value={String(d.field).slice(7)} onChange={(e) => set({ field: `custom.${slug(e.target.value)}` })} />}
              </div>
            </Field>
            <Field label="Value" htmlFor="sf-v" hint="Text or a placeholder such as {{last_reply}} or {{vars.rating}}.">
              <Input id="sf-v" maxLength={500} value={d.value ?? ''} onChange={(e) => set({ value: e.target.value })} />
            </Field>
          </>
        )}
        {node.type === 'loop' && (
          <>
            <Field label="Items" htmlFor="lp-i" hint="Separate with commas or new lines (up to 20). Placeholders work, e.g. {{vars.products}}.">
              <textarea id="lp-i" rows={4} className={textarea} value={d.items ?? ''} onChange={(e) => set({ items: e.target.value })} />
            </Field>
            <p className="text-xs text-slate-500">
              Connect &ldquo;Each item&rdquo; to the steps to repeat and connect the last of them back to this step. Use {'{{vars.item}}'} and {'{{vars.item_index}}'} inside. &ldquo;Done&rdquo; runs after the last item.
            </p>
          </>
        )}
        {node.type === 'book_appointment' && <BookingForm d={d} set={set} />}
        {node.type === 'create_ticket' && (
          <>
            <Field label="Ticket title" htmlFor="tk-t">
              <Input id="tk-t" maxLength={200} value={d.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <MessageText label="Description" value={d.description ?? ''} onChange={(description) => set({ description })} />
            <Field label="Priority" htmlFor="tk-p">
              <Select id="tk-p" value={d.priority ?? 'medium'} onChange={(e) => set({ priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </Field>
            <p className="text-xs text-slate-500">The ticket appears on the Tasks board, linked to the contact. Its number is {'{{vars.ticket_number}}'}.</p>
          </>
        )}
        {node.type === 'resolve_chat' && (
          <>
            <MessageText label="Closing message (optional)" value={d.message ?? ''} onChange={(message) => set({ message })} />
            <p className="text-xs text-slate-500">Marks the conversation resolved in the Team Inbox and ends the flow.</p>
          </>
        )}
        {node.type === 'google_sheets' && <SheetsForm d={d} set={set} accounts={deps.googleAccounts} />}
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

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);

function AmountUnit({ id, d, set }: { id?: string; d: Data; set: (p: Data) => void }) {
  return (
    <div className="flex gap-2">
      <Input id={id} aria-label="Amount" type="number" min={1} value={d.amount ?? 1} onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })} />
      <Select aria-label="Unit" value={d.unit ?? 'hours'} onChange={(e) => set({ unit: e.target.value })}>
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </Select>
    </div>
  );
}

function DayPicker({ label, value, onChange }: { label: string; value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-slate-700">{label}</p>
      <div className="flex gap-1">
        {WEEKDAYS.map((day, i) => {
          const on = value.includes(i);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i].sort())}
              className={on ? 'flex-1 rounded-md bg-brand-600 py-1 text-xs font-medium text-white' : 'flex-1 rounded-md bg-slate-100 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200'}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ListForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const rows: { id: string; title: string; description?: string }[] = d.rows ?? [];
  const update = (id: string, patch: Data) => set({ rows: rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  return (
    <>
      <Field label="Header (optional)" htmlFor="ls-h">
        <Input id="ls-h" maxLength={60} value={d.header ?? ''} onChange={(e) => set({ header: e.target.value })} />
      </Field>
      <MessageText label="Message" value={d.text} onChange={(text) => set({ text })} />
      <Field label="Footer (optional)" htmlFor="ls-f">
        <Input id="ls-f" maxLength={60} value={d.footer ?? ''} onChange={(e) => set({ footer: e.target.value })} />
      </Field>
      <Field label="Menu button text" htmlFor="ls-b" hint="Up to 20 characters.">
        <Input id="ls-b" maxLength={20} value={d.buttonText ?? ''} onChange={(e) => set({ buttonText: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <p className="font-medium text-slate-700">Options (each one gets its own path)</p>
        {rows.map((r, i) => (
          <RuleBox key={r.id} onRemove={rows.length > 1 ? () => set({ rows: rows.filter((x) => x.id !== r.id) }) : undefined}>
            <Input aria-label={`Option ${i + 1} title`} maxLength={24} placeholder="Title" value={r.title} onChange={(e) => update(r.id, { title: e.target.value })} />
            <Input aria-label={`Option ${i + 1} description`} maxLength={72} placeholder="Description (optional)" value={r.description ?? ''} onChange={(e) => update(r.id, { description: e.target.value })} />
          </RuleBox>
        ))}
        {rows.length < 10 && (
          <button type="button" onClick={() => set({ rows: [...rows, { id: uid(), title: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Plus className="size-3" /> Add option
          </button>
        )}
      </div>
      <Timeout d={d} set={set} />
    </>
  );
}

function MediaForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const items: { mediaType: string; link: string; caption: string }[] = d.items ?? [];
  const update = (i: number, patch: Data) => set({ items: items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      {items.map((item, i) => (
        <RuleBox key={i} onRemove={items.length > 1 ? () => set({ items: items.filter((_, j) => j !== i) }) : undefined}>
          <Select aria-label="Media type" value={item.mediaType} onChange={(e) => update(i, { mediaType: e.target.value })}>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="document">Document</option>
          </Select>
          <Input aria-label="Media link" type="url" placeholder="https://…/photo.jpg" value={item.link} onChange={(e) => update(i, { link: e.target.value })} />
          <Input aria-label="Caption" placeholder="Caption (optional)" maxLength={1024} value={item.caption ?? ''} onChange={(e) => update(i, { caption: e.target.value })} />
        </RuleBox>
      ))}
      {items.length < 10 && (
        <button type="button" onClick={() => set({ items: [...items, { mediaType: 'image', link: 'https://', caption: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus className="size-3" /> Add item
        </button>
      )}
      <p className="text-xs text-slate-500">Items are sent one after another, in this order. Links must be public https:// files.</p>
    </>
  );
}

function ContactsForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const contacts: { name: string; phone: string; organization?: string }[] = d.contacts ?? [];
  const update = (i: number, patch: Data) => set({ contacts: contacts.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      {contacts.map((c, i) => (
        <RuleBox key={i} onRemove={contacts.length > 1 ? () => set({ contacts: contacts.filter((_, j) => j !== i) }) : undefined}>
          <Input aria-label="Name" placeholder="Name" maxLength={80} value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
          <Input aria-label="Phone" type="tel" placeholder="+91 98765 43210" value={c.phone} onChange={(e) => update(i, { phone: e.target.value })} />
          <Input aria-label="Company" placeholder="Company (optional)" maxLength={80} value={c.organization ?? ''} onChange={(e) => update(i, { organization: e.target.value })} />
        </RuleBox>
      ))}
      {contacts.length < 5 && (
        <button type="button" onClick={() => set({ contacts: [...contacts, { name: '', phone: '', organization: '' }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus className="size-3" /> Add contact
        </button>
      )}
    </>
  );
}

function StageForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const STAGES = useStageOptions();
  return (
    <Field label="Lifecycle stage" htmlFor="st-s">
      <Select id="st-s" value={d.stage ?? ''} onChange={(e) => set({ stage: e.target.value })}>
        {STAGES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function BookingForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const slots: string[] = d.slots ?? [];
  return (
    <>
      <Field label="Service" htmlFor="bk-s">
        <Input id="bk-s" maxLength={120} value={d.service ?? ''} onChange={(e) => set({ service: e.target.value })} />
      </Field>
      <MessageText label="Message asking for a date" value={d.datePrompt} onChange={(datePrompt) => set({ datePrompt })} />
      <Field label="Message asking for a time" htmlFor="bk-t">
        <Input id="bk-t" maxLength={1024} value={d.timePrompt ?? ''} onChange={(e) => set({ timePrompt: e.target.value })} />
      </Field>
      <DayPicker label="Days you take appointments" value={d.workingDays ?? []} onChange={(workingDays) => set({ workingDays })} />
      <div className="flex gap-2">
        <Field label="Days offered" htmlFor="bk-d" hint="1 to 10">
          <Input id="bk-d" type="number" min={1} max={10} value={d.daysAhead ?? 7} onChange={(e) => set({ daysAhead: Math.max(1, Math.min(10, Number(e.target.value) || 7)) })} />
        </Field>
        <Field label="Length (minutes)" htmlFor="bk-l">
          <Input id="bk-l" type="number" min={5} value={d.durationMinutes ?? 30} onChange={(e) => set({ durationMinutes: Math.max(5, Number(e.target.value) || 30) })} />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="font-medium text-slate-700">Time slots</p>
        <div className="flex flex-wrap gap-1.5">
          {slots.map((slot, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md border border-slate-200 py-0.5 pr-1 pl-1.5">
              <input aria-label={`Slot ${i + 1}`} type="time" className="bg-transparent text-xs focus:outline-none" value={slot} onChange={(e) => set({ slots: slots.map((x, j) => (j === i ? e.target.value : x)) })} />
              <button type="button" onClick={() => set({ slots: slots.filter((_, j) => j !== i) })} className="text-slate-400 hover:text-red-600" aria-label="Remove slot">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        {slots.length < 10 && (
          <button type="button" onClick={() => set({ slots: [...slots, '09:00'] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Plus className="size-3" /> Add slot
          </button>
        )}
        <p className="text-xs text-slate-500">Slots already booked on the chosen day are hidden. Times use your workspace timezone.</p>
      </div>
      <MessageText label="Confirmation message (optional)" value={d.confirmation ?? ''} onChange={(confirmation) => set({ confirmation })} />
      <Timeout d={d} set={set} />
      <p className="text-xs text-slate-500">The booking shows up under Appointments as &ldquo;Booked&rdquo;.</p>
    </>
  );
}

function SheetsForm({ d, set, accounts }: { d: Data; set: (p: Data) => void; accounts: { id: string; email: string }[] }) {
  const values: string[] = d.values ?? [];
  return (
    <>
      <Field label="Google account" htmlFor="gs-a" hint={accounts.length ? undefined : 'Connect a Google account under Integrations → Google Sheets first.'}>
        <Select id="gs-a" value={d.googleAccountId ?? ''} onChange={(e) => set({ googleAccountId: e.target.value })}>
          <option value="">Choose an account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Sheet link" htmlFor="gs-u">
        <Input id="gs-u" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={d.sheetUrl ?? ''} onChange={(e) => set({ sheetUrl: e.target.value })} />
      </Field>
      <Field label="Tab name" htmlFor="gs-t">
        <Input id="gs-t" maxLength={100} value={d.tab ?? 'Sheet1'} onChange={(e) => set({ tab: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <p className="font-medium text-slate-700">Row values (one per column)</p>
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-xs font-medium text-slate-400">{String.fromCharCode(65 + i)}</span>
            <Input aria-label={`Column ${String.fromCharCode(65 + i)}`} value={v} placeholder="{{vars.answer}}" onChange={(e) => set({ values: values.map((x, j) => (j === i ? e.target.value : x)) })} />
            {values.length > 1 && (
              <button type="button" onClick={() => set({ values: values.filter((_, j) => j !== i) })} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove column">
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
        {values.length < 26 && (
          <button type="button" onClick={() => set({ values: [...values, ''] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Plus className="size-3" /> Add column
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">The row is added below the last one. The Google account needs edit access to the sheet.</p>
    </>
  );
}

function HttpForm({ d, set }: { d: Data; set: (p: Data) => void }) {
  const headers: { key: string; value: string }[] = d.headers ?? [];
  const saves: { path: string; var: string }[] = d.saveResponse ?? [];
  const hasBody = d.method !== 'GET' && d.method !== 'DELETE';
  return (
    <>
      <div className="flex gap-2">
        <div className="w-28 shrink-0">
          <Select aria-label="Method" value={d.method ?? 'POST'} onChange={(e) => set({ method: e.target.value, ...(['GET', 'DELETE'].includes(e.target.value) ? { body: '' } : {}) })}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </div>
        <Input aria-label="URL" value={d.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://api.yourshop.com/orders/{{vars.order_id}}" />
      </div>
      <p className="text-xs text-slate-500">{'{{placeholders}}'} work in the path, query, headers and body (not the host).</p>

      <div className="space-y-2">
        <p className="font-medium text-slate-700">Headers</p>
        {headers.map((h, i) => (
          <div key={i} className="flex gap-1.5">
            <Input aria-label="Header name" value={h.key} placeholder="Authorization" onChange={(e) => set({ headers: headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
            <Input aria-label="Header value" value={h.value} placeholder="Bearer …" onChange={(e) => set({ headers: headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
            <button type="button" onClick={() => set({ headers: headers.filter((_, j) => j !== i) })} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove header">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {headers.length < 10 && (
          <Button type="button" variant="secondary" className="py-1 text-xs" onClick={() => set({ headers: [...headers, { key: '', value: '' }] })}>
            <Plus className="size-3.5" /> Header
          </Button>
        )}
        <p className="text-xs text-slate-500">Header values are stored in the flow. Use a key that can only do what this step needs.</p>
      </div>

      {hasBody && (
        <Field label="Body" htmlFor="http-body" hint='JSON bodies: put placeholders inside quotes, e.g. "name": "{{contact.name}}". Values are escaped for you.'>
          <textarea id="http-body" rows={6} className={`${textarea} font-mono text-xs`} value={d.body ?? ''} onChange={(e) => set({ body: e.target.value })} />
        </Field>
      )}

      <div className="space-y-2">
        <p className="font-medium text-slate-700">Save from the JSON response</p>
        {saves.map((m, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input aria-label="Response path" value={m.path} placeholder="data.status" onChange={(e) => set({ saveResponse: saves.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
            <span className="text-xs text-slate-400">→</span>
            <Input aria-label="Variable name" value={m.var} placeholder="order_status" onChange={(e) => set({ saveResponse: saves.map((x, j) => (j === i ? { ...x, var: e.target.value } : x)) })} />
            <button type="button" onClick={() => set({ saveResponse: saves.filter((_, j) => j !== i) })} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove mapping">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {saves.length < 10 && (
          <Button type="button" variant="secondary" className="py-1 text-xs" onClick={() => set({ saveResponse: [...saves, { path: '', var: '' }] })}>
            <Plus className="size-3.5" /> Mapping
          </Button>
        )}
        <p className="text-xs text-slate-500">
          Saved values become {'{{vars.<name>}}'}; the status code is always in {'{{vars.http_status}}'}. 2xx follows &ldquo;Success&rdquo;, anything else or a timeout follows &ldquo;Failed&rdquo;.
        </p>
      </div>
      <Field label="Timeout (seconds)" htmlFor="http-t">
        <Input id="http-t" type="number" min={1} max={15} value={d.timeoutSeconds ?? 10} onChange={(e) => set({ timeoutSeconds: Math.max(1, Math.min(15, Number(e.target.value) || 10)) })} />
      </Field>
    </>
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

function TriggerForm({ d, set, tags, forms }: { d: Data; set: (p: Data) => void; tags: Tag[]; forms: WaForm[] }) {
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
          <option value="form_submitted">A WhatsApp form is submitted</option>
          <option value="api">Started by API / Zapier</option>
        </Select>
      </Field>
      {d.event === 'api' && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          Start it from your system with <code className="font-mono">POST /api/v1/flows/&lt;flow id&gt;/runs</code> (Developers page). Values you pass in <code className="font-mono">variables</code> are available as {'{{vars.<name>}}'}. Start with a template if the customer may not have messaged in 24 hours.
        </p>
      )}
      {d.event === 'form_submitted' && (
        <Field label="Form" htmlFor="tr-f">
          <Select id="tr-f" value={d.formId ?? ''} onChange={(e) => set({ formId: e.target.value || null })}>
            <option value="">Choose a form</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
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
            set({
              templateId: e.target.value,
              headerVariables: fit([], t?.variables.header ?? 0),
              bodyVariables: fit([], t?.variables.body ?? 0),
              buttonVariables: Array.from({ length: t?.requirements.buttons.length ?? 0 }, () => ({ source: 'static', value: '', fallback: '' })),
              templateExtras: emptyExtras(t?.requirements),
            });
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
          {template.requirements.buttons.map((b, i) => (
            <VariableRow
              key={`btn${i}`}
              label={b.type === 'COPY_CODE' ? 'Offer code' : `“${b.text}” link`}
              spec={d.buttonVariables?.[i] ?? { source: 'static', value: '', fallback: '' }}
              disabled={false}
              onChange={(spec) =>
                set({ buttonVariables: template.requirements.buttons.map((_, j) => (j === i ? spec : (d.buttonVariables?.[j] ?? { source: 'static', value: '', fallback: '' }))) })
              }
            />
          ))}
          <TemplateExtrasFields requirements={template.requirements} value={(d.templateExtras ?? {}) as TemplateExtras} onChange={(templateExtras) => set({ templateExtras })} shared />
          <TemplatePreview components={template.components} {...extrasPreview((d.templateExtras ?? {}) as TemplateExtras)} />
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
  const STAGES = useStageOptions();
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
  const STAGES = useStageOptions();
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
