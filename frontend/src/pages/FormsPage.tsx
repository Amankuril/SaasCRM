import { useMutation, useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, errorMessage } from '../components/ui';
import { api, type WaForm } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

export const FORM_STATUS = {
  draft: { label: 'Draft', tone: 'gray' },
  published: { label: 'Published', tone: 'green' },
  failed: { label: 'Publish failed', tone: 'red' },
} as const;

export function FormsPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['forms', workspace.id], queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`) });
  const create = useMutation({
    mutationFn: () => api.post<{ form: WaForm }>(`/workspaces/${workspace.id}/forms`, { name: 'Untitled form' }),
    onSuccess: ({ form }) => navigate(`/w/${workspace.id}/forms/${form.id}`),
  });

  return (
    <>
      <PageHeader
        title="WhatsApp Forms"
        description="Native forms that open inside WhatsApp: bookings, lead capture, feedback."
        actions={
          can('forms:manage') &&
          workspace.status !== 'suspended' && (
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              <Plus className="size-4" /> New form
            </Button>
          )
        }
      />
      {create.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.forms.length === 0 ? (
          <EmptyState icon={<ClipboardList className="size-5" />} title="No forms yet">
            Build an appointment request or lead form, publish it to WhatsApp, then send it from a flow or the form page.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.forms.map((f) => (
              <li key={f.id}>
                <Link to={`/w/${workspace.id}/forms/${f.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-800">{f.name}</p>
                    <p className="text-xs text-slate-500">
                      {f.fields.length} field(s) · updated {formatDate(f.updatedAt)}
                      {f.status === 'published' && f.hasUnpublishedChanges && <span className="text-amber-600"> · unpublished changes</span>}
                    </p>
                  </div>
                  <span className="text-xs text-slate-500">{f.submissions ?? 0} submissions</span>
                  <Badge tone={FORM_STATUS[f.status].tone}>
                    {FORM_STATUS[f.status].label}
                    {f.version > 0 && ` · v${f.version}`}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
