import { BarChart3, BookOpen, CalendarCheck, Database, Megaphone, MessagesSquare, Workflow, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { SectionNav } from '../components/SectionNav';
import { AutomationsTab } from './flows/AutomationsTab';
import { FlowAdsTab } from './flows/FlowAdsTab';
import { FlowAppointmentsTab } from './flows/FlowAppointmentsTab';
import { FlowDashboardTab } from './flows/FlowDashboardTab';
import { FlowDataTab } from './flows/FlowDataTab';
import { FlowDocsTab } from './flows/FlowDocsTab';
import { FlowRunsTab } from './flows/FlowRunsTab';

export { FLOW_STATUS } from './flows/shared';

const TABS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { key: 'builder', label: 'Automations', icon: Workflow },
  { key: 'appointments', label: 'Appointments', icon: CalendarCheck },
  { key: 'conversations', label: 'Conversations', icon: MessagesSquare },
  { key: 'data', label: 'Collected data', icon: Database },
  { key: 'ads', label: 'Ads', icon: Megaphone },
  { key: 'docs', label: 'Documentation', icon: BookOpen },
];

/** The Flow Builder module: one page, seven tabs (kept in ?tab= so links and refresh keep the tab). */
export function FlowsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'builder';

  return (
    <>
      <SectionNav
        label="Flow builder"
        className="-mx-4 -mt-6 mb-6 sm:-mx-6 lg:-mx-8 lg:px-8"
        items={TABS.map((t) => ({ label: t.label, icon: t.icon, active: tab === t.key, onSelect: () => setParams(t.key === 'builder' ? {} : { tab: t.key }) }))}
      />
      {tab === 'dashboard' && <FlowDashboardTab />}
      {tab === 'builder' && <AutomationsTab />}
      {tab === 'appointments' && <FlowAppointmentsTab />}
      {tab === 'conversations' && <FlowRunsTab />}
      {tab === 'data' && <FlowDataTab />}
      {tab === 'ads' && <FlowAdsTab />}
      {tab === 'docs' && <FlowDocsTab onOpenBuilder={() => setParams({})} />}
    </>
  );
}
