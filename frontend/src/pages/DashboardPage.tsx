import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Badge, Card, PageHeader } from '../components/ui';
import { api, type ConnectionPayload } from '../lib/api';
import { useWorkspace } from '../layouts/workspaceContext';

const STATUS_BADGE = {
  setup: <Badge tone="amber">Setup in progress</Badge>,
  active: <Badge tone="green">Active</Badge>,
  suspended: <Badge tone="red">Suspended</Badge>,
};

export function DashboardPage() {
  const { user } = useAuth();
  const { workspace, can } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const whatsapp = useQuery({
    queryKey: ['whatsapp', workspace.id],
    queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`),
  });
  const connection = whatsapp.data?.connection;
  const link = (to: string, label: string) => (
    <Link to={`${base}/${to}`} className="text-sm font-medium text-brand-700 hover:underline">
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.name.split(' ')[0] ?? ''}`}
        description={`Here's how ${workspace.name} is set up.`}
        actions={STATUS_BADGE[workspace.status]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Setup checklist</h2>
            <p className="mt-0.5 text-sm text-slate-500">Finish these steps to start messaging customers on WhatsApp.</p>
          </div>
          <ul className="divide-y divide-slate-100">
            <Step done title="Create your workspace" description="Business details, timezone and currency." />
            <Step
              title="Invite your team"
              description="Add receptionists, agents and managers with the right roles."
              action={can('members:manage') ? link('team', 'Invite') : undefined}
            />
            <Step
              done={!!connection}
              title="Connect your WhatsApp Business number"
              description={
                connection
                  ? `Connected: ${connection.displayPhoneNumber ?? connection.phoneNumberId}${connection.status === 'error' ? ' (needs attention)' : ''}`
                  : 'Link the number your customers already message.'
              }
              action={!connection && can('provider:manage') ? link('whatsapp', 'Connect') : undefined}
            />
            <Step
              title="Sync or create message templates"
              description="Templates are needed for reminders, broadcasts and messages outside the 24-hour window."
              action={connection && can('templates:manage') ? link('templates', 'Open templates') : undefined}
            />
            <Step pending title="Import your contacts" description="Upload a CSV of customers with tags and consent." />
            <Step pending title="Send your first broadcast or build a flow" description="Campaigns and automations arrive in the next phases." />
          </ul>
        </Card>

        <Card className="p-5">
          <div className="mb-3 inline-flex rounded-lg bg-brand-50 p-2 text-brand-700">
            <MessageCircle className="size-5" />
          </div>
          <h2 className="text-sm font-semibold text-ink">Messaging stats</h2>
          <p className="mt-1 text-sm text-slate-500">
            Conversations, delivery rates and campaign results will appear here with the inbox and campaigns (next phases).
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {['Contacts', 'Open chats', 'Messages sent', 'Delivery rate'].map((label) => (
              <div key={label} className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="mt-1 font-semibold text-slate-400">—</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}

function Step({
  title,
  description,
  done = false,
  pending = false,
  action,
}: {
  title: string;
  description: string;
  done?: boolean;
  pending?: boolean;
  action?: ReactNode;
}) {
  const icon = done ? (
    <CheckCircle2 className="size-5 text-brand-600" />
  ) : pending ? (
    <Clock className="size-5 text-slate-300" />
  ) : (
    <Circle className="size-5 text-slate-300" />
  );
  return (
    <li className="flex items-start gap-3 px-5 py-4">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={done ? 'text-sm font-medium text-slate-500 line-through' : 'text-sm font-medium text-slate-800'}>{title}</p>
        <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      </div>
      {action ?? (pending && <Badge>Coming soon</Badge>)}
    </li>
  );
}
