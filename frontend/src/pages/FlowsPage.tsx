import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Workflow } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, errorMessage } from '../components/ui';
import { api, type FlowDetail, type FlowStatus, type FlowSummary } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

export const FLOW_STATUS: Record<FlowStatus, { label: string; tone: 'gray' | 'green' | 'amber' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  active: { label: 'Live', tone: 'green' },
  inactive: { label: 'Off', tone: 'amber' },
};

const TRIGGER_TEXT: Record<string, string> = {
  any_message: 'Any message',
  new_contact: 'New contact',
  tag_added: 'Tag added',
  form_submitted: 'Form submitted',
  api: 'Started by API',
};

export function FlowsPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['flows', workspace.id], queryFn: () => api.get<{ flows: FlowSummary[] }>(`/workspaces/${workspace.id}/flows`) });
  const create = useMutation({
    mutationFn: () => api.post<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows`, { name: 'Untitled flow' }),
    onSuccess: ({ flow }) => navigate(`/w/${workspace.id}/flows/${flow.id}`),
  });

  return (
    <>
      <PageHeader
        title="Flow Builder"
        description="Chatbots and automations that reply, ask, tag and hand off for you."
        actions={
          can('flows:manage') &&
          workspace.status !== 'suspended' && (
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              <Plus className="size-4" /> New flow
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
        ) : list.data.flows.length === 0 ? (
          <EmptyState icon={<Workflow className="size-5" />} title="No flows yet">
            Start with a keyword bot: a customer sends &ldquo;review&rdquo;, the bot asks a question with buttons and acts on the answer.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Flow</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Trigger</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">Runs (30d)</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.flows.map((f) => {
                  const s = f.stats30d ?? {};
                  const runs = Object.values(s).reduce((a, b) => a + (b ?? 0), 0);
                  return (
                    <tr key={f.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link to={`/w/${workspace.id}/flows/${f.id}`} className="font-medium text-slate-800 hover:text-brand-700">
                          {f.name}
                        </Link>
                        {f.status !== 'draft' && f.hasUnpublishedChanges && <p className="text-xs text-amber-600">Unpublished changes</p>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={FLOW_STATUS[f.status].tone}>
                          {FLOW_STATUS[f.status].label}
                          {f.publishedVersion > 0 && ` · v${f.publishedVersion}`}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 text-slate-600 md:table-cell">
                        {f.trigger?.event === 'keyword' ? (f.trigger.keywords.length ? `“${f.trigger.keywords.join('”, “')}”` : 'Keyword (not set)') : TRIGGER_TEXT[f.trigger?.event ?? ''] ?? '—'}
                      </td>
                      <td className="hidden px-4 py-3 text-right text-slate-600 lg:table-cell">
                        {runs || '—'}
                        {s.failed ? <span className="ml-1 text-red-600">({s.failed} failed)</span> : null}
                      </td>
                      <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">{formatDate(f.draftUpdatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
