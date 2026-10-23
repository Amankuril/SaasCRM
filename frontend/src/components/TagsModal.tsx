import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, type Tag, type TagColor } from '../lib/api';
import { useTags } from '../lib/hooks';
import { useWorkspace } from '../layouts/workspaceContext';
import { Modal, TAG_COLORS, TagChip } from './crm';
import { Alert, Button, Input, Select, errorMessage } from './ui';

export function TagsModal({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const tags = useTags(workspace.id);
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('blue');
  const base = `/workspaces/${workspace.id}/tags`;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tags', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
  };

  const create = useMutation({
    mutationFn: () => api.post(base, { name, color }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const update = useMutation({ mutationFn: ({ id, ...body }: Partial<Tag> & { id: string }) => api.patch(`${base}/${id}`, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`${base}/${id}`), onSuccess: refresh });
  const error = create.error ?? update.error ?? remove.error;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Modal title="Tags" onClose={onClose}>
      {error != null && (
        <div className="mb-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input aria-label="New tag name" placeholder="New tag, e.g. VIP" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="w-28 shrink-0">
          <Select aria-label="Tag colour" value={color} onChange={(e) => setColor(e.target.value as TagColor)}>
            {TAG_COLORS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      <ul className="mt-4 max-h-80 divide-y divide-slate-100 overflow-y-auto">
        {tags.data?.length === 0 && <li className="py-6 text-center text-sm text-slate-500">No tags yet.</li>}
        {tags.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2.5">
            <TagChip tag={t} />
            <span className="text-xs text-slate-400">{t.contactCount ?? 0} contacts</span>
            <div className="ml-auto w-24">
              <Select aria-label={`Colour for ${t.name}`} value={t.color} onChange={(e) => update.mutate({ id: t.id, color: e.target.value as TagColor })}>
                {TAG_COLORS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <button
              onClick={() => window.confirm(`Delete tag "${t.name}"? It will be removed from all contacts.`) && remove.mutate(t.id)}
              className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label={`Delete ${t.name}`}
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
