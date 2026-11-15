import { BarChart3, BookOpen, CalendarCheck, Database, Megaphone, MessagesSquare, Workflow, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { cn } from '../components/ui';
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
  { key: 'builder', label: 'Flow Builder', icon: Workflow },
  { key: 'appointments', label: 'Appointments', icon: CalendarCheck },
  { key: 'conversations', label: 'Conversations', icon: MessagesSquare },
  { key: 'data', label: 'Collected Data', icon: Database },
  { key: 'ads', label: 'Ads', icon: Megaphone },
  { key: 'docs', label: 'Documentation', icon: BookOpen },
];

/** The Flow Builder module: one page, seven tabs (kept in ?tab= so links and refresh keep the tab). */
export function FlowsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'builder';

  return (
    <>
      <nav aria-label="Flow Builder sections" className="no-scrollbar -mx-1 mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200 px-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setParams(t.key === 'builder' ? {} : { tab: t.key })}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition',
              tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
            )}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </nav>
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
