import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ConfirmDialog, SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { Alert, Button, LoadError, Tabs, errorMessage } from '../../components/ui';
import { ApiError, api, type ReminderAccess, type ReminderCategory, type ReminderSetup } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ReminderContacts } from './ReminderContacts';
import { ReminderForm } from './ReminderForm';
import { ReminderLogTab } from './ReminderLogTab';
import { CategoryIcon } from './shared';

export interface SetupPayload {
  setup: ReminderSetup;
  category: ReminderCategory;
  access: ReminderAccess;
  timezone: string;
}

type Tab = 'setup' | 'contacts' | 'log';

/** One reminder: its setup, the people in it and everything it has sent. */
export function ReminderSetupPage() {
  const { workspace, can } = useWorkspace();
  const { setupId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (['setup', 'contacts', 'log'].includes(params.get('tab') ?? '') ? params.get('tab') : 'setup') as Tab;
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const url = `/workspaces/${workspace.id}/reminders/setups/${setupId}`;
  const query = useQuery({ queryKey: ['reminders', workspace.id, 'setup', setupId], queryFn: () => api.get<SetupPayload>(url) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });

  const activate = useMutation({
    mutationFn: () => api.post(`${url}/activate`, {}),
    onSuccess: () => {
      toast.success('This reminder is live.');
      void refresh();
    },
  });
  const pause = useMutation({
    mutationFn: () => api.post(`${url}/pause`),
    onSuccess: () => {
      toast.info('Paused. Nothing is sent until you resume it.');
      void refresh();
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(url),
    onSuccess: () => {
      void refresh();
      navigate(`/w/${workspace.id}/reminders`);
    },
    onError: (e) => toast.error(e),
  });

  if (query.error) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return gone ? (
      <div className="py-16 text-center text-sm text-slate-500">
        This reminder no longer exists.{' '}
        <Link to={`/w/${workspace.id}/reminders`} className="font-medium text-brand-700 hover:underline">
          Back to date reminders
        </Link>
      </div>
    ) : (
      <LoadError error={query.error} what="this reminder" onRetry={() => void query.refetch()} />
    );
  }
  if (!query.data) return <SkeletonRows />;
  const { setup, category, access, timezone } = query.data;
  const canManage = can('campaigns:manage') && workspace.status !== 'suspended';
  const details = activate.error instanceof ApiError ? Object.values(activate.error.details ?? {}).flat() : [];

  return (
    <>
      <Link to={`/w/${workspace.id}/reminders/type/${category.key}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> {category.key === 'custom' ? 'Your own event types' : category.name}
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-4">
          <CategoryIcon category={setup.category} className="size-11" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl leading-8 font-medium text-ink">{setup.name}</h1>
              <StatusBadge status={setup.status} label={setup.status === 'active' ? 'Live' : undefined} />
            </div>
            <p className="text-sm text-slate-500">
              {setup.eventLabel ?? category.name}, {setup.counts.contacts} contact{setup.counts.contacts === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" aria-label="Delete reminder" title="Delete reminder" onClick={() => setDeleting(true)}>
              <Trash2 className="size-4" strokeWidth={1.5} />
            </Button>
            {setup.status === 'active' ? (
              <Button variant="secondary" loading={pause.isPending} onClick={() => pause.mutate()}>
                <Pause className="size-4" strokeWidth={1.5} /> Pause
              </Button>
            ) : (
              <Button loading={activate.isPending} disabled={!access.unlocked} onClick={() => (tab === 'setup' ? activate.mutate() : setParams({}))}>
                <Play className="size-4" strokeWidth={1.5} /> {tab === 'setup' ? (setup.status === 'paused' ? 'Resume' : 'Activate') : 'Review and activate'}
              </Button>
            )}
          </div>
        )}
      </div>

      <Tabs
        label="Reminder"
        value={tab}
        onChange={(v) => setParams(v === 'setup' ? {} : { tab: v })}
        tabs={[
          { value: 'setup', label: 'Setup' },
          { value: 'contacts', label: 'Contacts', count: setup.counts.contacts },
          { value: 'log', label: 'Log', count: setup.counts.sent + setup.counts.failed + setup.counts.skipped + setup.counts.pending },
        ]}
      />
      <div className="pt-6">
        {activate.error != null && (
          <div className="mb-4">
            <Alert>
              {errorMessage(activate.error)}
              {details.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {details.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </Alert>
          </div>
        )}
        {tab === 'setup' && <ReminderForm key={setup.id} setup={setup} category={category} timezone={timezone} url={url} canManage={canManage && access.unlocked} onContacts={() => setParams({ tab: 'contacts' })} />}
        {tab === 'contacts' && <ReminderContacts setup={setup} category={category} timezone={timezone} url={url} canManage={canManage} locked={!access.unlocked} />}
        {tab === 'log' && <ReminderLogTab url={url} timezone={timezone} canManage={canManage} live={setup.status === 'active'} />}
      </div>
      {deleting && (
        <ConfirmDialog title={`Delete ${setup.name}`} loading={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => setDeleting(false)}>
          The setup, its {setup.counts.contacts} contacts and its log are removed. Messages already sent stay in the inbox.
        </ConfirmDialog>
      )}
    </>
  );
}
