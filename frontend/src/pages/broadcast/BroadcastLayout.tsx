import { BookOpen, ListChecks, Megaphone, Repeat, Users } from 'lucide-react';
import { Outlet, useMatch } from 'react-router';
import { SectionNav } from '../../components/SectionNav';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Broadcast area: contact lists and campaigns. */
export function BroadcastLayout() {
  const { workspace, can } = useWorkspace();
  // Creating a campaign and the campaign list are separate pages: each one highlights only itself.
  const onCreate = useMatch('/w/:workspaceId/broadcast/campaigns/new');
  const onCampaign = useMatch('/w/:workspaceId/broadcast/campaigns/:campaignId');
  const base = `/w/${workspace.id}/broadcast`;
  const canCreate = can('campaigns:manage') && workspace.status !== 'suspended';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionNav
        label="Broadcasts"
        items={[
          { to: base, label: 'Contact lists', icon: Users, end: true },
          ...(canCreate ? [{ to: `${base}/campaigns/new`, label: 'Create campaign', icon: Megaphone, end: true }] : []),
          { to: `${base}/campaigns`, label: 'Campaigns', icon: ListChecks, end: true, active: !!onCampaign && !onCreate },
          { to: `${base}/retarget`, label: 'Retarget', icon: Repeat },
          { to: `${base}/guide`, label: 'User guide', icon: BookOpen },
        ]}
      />
      {onCampaign ? (
        // A campaign page manages its own scrolling (the builder has a sticky action bar).
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </div>
      )}
    </div>
  );
}
