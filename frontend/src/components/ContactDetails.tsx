import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type ConsentStatus, type Contact, type LifecycleStage } from '../lib/api';
import { useMembers, useTags } from '../lib/hooks';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';
import { CONSENT_LABEL, STAGES, TagChip } from './crm';
import { Alert, Button, Field, Input, Select, errorMessage, fieldError } from './ui';

/** Editable CRM card for one contact. Saves field-by-field (stage, tags...) or via the form. */
export function ContactDetails({ contact, compact = false }: { contact: Contact; compact?: boolean }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const tags = useTags(workspace.id);
  const members = useMembers(workspace.id, can('members:read'));

  const [name, setName] = useState(contact.name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [custom, setCustom] = useState(Object.entries(contact.customFields));
  useEffect(() => {
    setName(contact.name ?? '');
    setEmail(contact.email ?? '');
    setCustom(Object.entries(contact.customFields));
  }, [contact]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<{ contact: Contact }>(`/workspaces/${workspace.id}/contacts/${contact.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contact', workspace.id, contact.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
    },
  });

  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const unusedTags = (tags.data ?? []).filter((t) => !contact.tags.includes(t.id));
  const dirty = name !== (contact.name ?? '') || email !== (contact.email ?? '') || JSON.stringify(custom) !== JSON.stringify(Object.entries(contact.customFields));

  return (
    <div className="space-y-4 text-sm">
      {save.error != null && fieldError(save.error, 'email') == null && fieldError(save.error, 'customFields') == null && <Alert>{errorMessage(save.error)}</Alert>}

      <div>
        <p className="text-xs text-slate-500">Phone</p>
        <p className="font-medium text-slate-800">{contact.phone}</p>
        {contact.profileName && <p className="text-xs text-slate-500">WhatsApp name: {contact.profileName}</p>}
      </div>

      <div className={compact ? 'space-y-3' : 'grid gap-3 sm:grid-cols-2'}>
        <Field label="Lifecycle stage" htmlFor={`stage-${contact.id}`}>
          <Select id={`stage-${contact.id}`} disabled={!editable} value={contact.lifecycleStage} onChange={(e) => save.mutate({ lifecycleStage: e.target.value as LifecycleStage })}>
            {STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="WhatsApp consent" htmlFor={`consent-${contact.id}`} hint={contact.consent.updatedAt ? `Updated ${formatDate(contact.consent.updatedAt)}` : undefined}>
          <Select id={`consent-${contact.id}`} disabled={!editable} value={contact.consent.status} onChange={(e) => save.mutate({ consentStatus: e.target.value as ConsentStatus })}>
            {Object.entries(CONSENT_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {members.data && (
          <Field label="Owner" htmlFor={`owner-${contact.id}`}>
            <Select id={`owner-${contact.id}`} disabled={!editable} value={contact.ownerId ?? ''} onChange={(e) => save.mutate({ ownerId: e.target.value || null })}>
              <option value="">No owner</option>
              {members.data
                .filter((m) => m.role !== 'analyst')
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-xs text-slate-500">Tags</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {contact.tags.map((id) => {
            const tag = tagById.get(id);
            return tag ? <TagChip key={id} tag={tag} onRemove={editable ? () => save.mutate({ tags: contact.tags.filter((t) => t !== id) }) : undefined} /> : null;
          })}
          {contact.tags.length === 0 && <span className="text-xs text-slate-400">No tags</span>}
          {editable && unusedTags.length > 0 && (
            <select
              aria-label="Add tag"
              value=""
              onChange={(e) => e.target.value && save.mutate({ tags: [...contact.tags, e.target.value] })}
              className="rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600"
            >
              <option value="">+ Add tag</option>
              {unusedTags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <form
        className="space-y-3 border-t border-slate-100 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ name: name.trim() || null, email: email.trim(), customFields: Object.fromEntries(custom.filter(([k]) => k.trim())) });
        }}
      >
        <Field label="Name" htmlFor={`name-${contact.id}`}>
          <Input id={`name-${contact.id}`} disabled={!editable} value={name} onChange={(e) => setName(e.target.value)} placeholder={contact.profileName ?? ''} />
        </Field>
        <Field label="Email" htmlFor={`email-${contact.id}`} error={fieldError(save.error, 'email')}>
          <Input id={`email-${contact.id}`} type="email" disabled={!editable} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Custom fields</p>
          <div className="space-y-2">
            {custom.map(([k, v], i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label="Field name" placeholder="field_name" value={k} disabled={!editable} onChange={(e) => setCustom(custom.map((c, j) => (j === i ? [e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'), c[1]] : c)))} />
                <Input aria-label="Field value" placeholder="Value" value={v} disabled={!editable} onChange={(e) => setCustom(custom.map((c, j) => (j === i ? [c[0], e.target.value] : c)))} />
                {editable && (
                  <button type="button" onClick={() => setCustom(custom.filter((_, j) => j !== i))} className="rounded p-2 text-slate-400 hover:text-red-600" aria-label="Remove field">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
            {fieldError(save.error, 'customFields') && <p className="text-xs text-red-600">{fieldError(save.error, 'customFields')}</p>}
            {editable && (
              <button type="button" onClick={() => setCustom([...custom, ['', '']])} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                <Plus className="size-3" /> Add field
              </button>
            )}
          </div>
        </div>

        {editable && dirty && (
          <Button type="submit" loading={save.isPending}>
            Save details
          </Button>
        )}
      </form>

      <p className="text-xs text-slate-400">
        Added {formatDate(contact.createdAt)}
        {contact.source ? ` · via ${contact.source.replace(/_/g, ' ')}` : ''}
      </p>
    </div>
  );
}
