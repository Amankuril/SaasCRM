import { AlarmClock, BarChart3, Bookmark, CalendarCheck, Columns3, KanbanSquare, LineChart, Users } from 'lucide-react';
import { Outlet } from 'react-router';
import { SectionNav } from '../../components/SectionNav';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Audience area: customers and everything tracked about them. */
export function AudienceLayout() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/audience`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionNav
        label="Audience"
        items={[
          { to: base, label: 'Customers', icon: Users, end: true },
          { to: `${base}/segments`, label: 'Segments', icon: Bookmark },
          { to: `${base}/pipeline`, label: 'Sales pipeline', icon: Columns3 },
          { to: `${base}/tasks`, label: 'Task board', icon: KanbanSquare },
          { to: `${base}/follow-ups`, label: 'Follow-ups', icon: AlarmClock },
          { to: `${base}/appointments`, label: 'Appointments', icon: CalendarCheck },
          { label: 'Task analytics', icon: BarChart3 },
          { label: 'Sales analytics', icon: LineChart },
        ]}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
