import { FileText, Megaphone } from 'lucide-react';
import { Outlet } from 'react-router';
import { SectionNav } from '../../components/SectionNav';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Automation > Facebook Leads: Ads (this phase) and Lead forms (next phase). */
export function FacebookLayout() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/facebook`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionNav
        label="Facebook Leads"
        items={[
          { to: `${base}/ads`, label: 'Ads', icon: Megaphone },
          { label: 'Lead forms', icon: FileText },
        ]}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
