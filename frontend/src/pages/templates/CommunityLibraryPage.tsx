import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Search, Trash2, Users } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, EmptyState, Input, Select, Spinner, errorMessage } from '../../components/ui';
import { api, type CommunityTemplate } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CATEGORY_LABEL, TYPE_INFO, componentsToForm } from './templateForm';
import { TemplatesHeader, TypePill } from './shared';

export function CommunityLibraryPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const canManage = can('templates:manage') && workspace.status !== 'suspended';

  const list = useQuery({
    queryKey: ['community-templates', workspace.id, { deferredQ, category, type }],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ q: deferredQ, category, type })) if (v) params.set(k, v);
      return api.get<{ templates: CommunityTemplate[] }>(`/workspaces/${workspace.id}/templates/community?${params}`);
    },
  });

  // Reusing opens the builder prefilled; media samples must be uploaded again.
  const use = useMutation({
    mutationFn: (t: CommunityTemplate) => api.post<{ template: CommunityTemplate }>(`/workspaces/${workspace.id}/templates/community/${t.id}/use`),
    onSuccess: ({ template: t }) => {
      const form = componentsToForm({ ...t, name: '' });
      const prefill = { ...form, headerHandle: '', cards: form.cards.map((c) => ({ ...c, handle: '' })) };
      navigate(`/w/${workspace.id}/templates/new`, { state: { prefill } });
    },
  });
  const remove = useMutation({
    mutationFn: (t: CommunityTemplate) => api.delete(`/workspaces/${workspace.id}/templates/community/${t.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['community-templates', workspace.id] }),
  });
  const actionError = use.error ?? remove.error;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TemplatesHeader title="Community Library" description="Approved templates shared by other businesses. Use one as a starting point — it is submitted under your own account." />
      <div className="space-y-4 px-4 py-4 sm:px-6">
        {actionError != null && <Alert>{errorMessage(actionError)}</Alert>}
        <div className="flex flex-wrap gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search community templates" placeholder="Search templates..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-full pl-9" />
          </div>
          <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-40!">
            <option value="">All Categories</option>
            {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-40!">
            <option value="">All Types</option>
            {TYPE_INFO.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type === 'CUSTOM' ? 'Custom' : t.label}
              </option>
            ))}
          </Select>
        </div>

        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <Alert>{errorMessage(list.error)}</Alert>
        ) : list.data.templates.length === 0 ? (
          <EmptyState icon={<BookOpen className="size-5" />} title="Nothing shared yet">
            Share one of your approved templates from All Templates → ⋯ → Contribute to library.
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.templates.map((t) => (
              <div key={t.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800" title={t.name}>
                      {t.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      by {t.mine ? 'you' : t.contributorName} · {CATEGORY_LABEL[t.category] ?? t.category} · {t.language}
                    </p>
                  </div>
                  <TypePill type={t.type} />
                </div>
                <div className="flex-1">
                  <TemplatePreview components={t.components} />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                    <Users className="size-3.5" /> {t.uses} use{t.uses === 1 ? '' : 's'}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {t.mine && canManage && (
                      <Button variant="danger" onClick={() => remove.mutate(t)} loading={remove.isPending && remove.variables?.id === t.id} aria-label="Remove from library" title="Remove from library">
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                    {canManage && (
                      <Button onClick={() => use.mutate(t)} loading={use.isPending && use.variables?.id === t.id} className="bg-slate-700 hover:bg-slate-800">
                        Use template
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
