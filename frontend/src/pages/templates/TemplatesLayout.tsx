import { BookOpen, LayoutList, Library, SquarePlus } from 'lucide-react';
import { Outlet } from 'react-router';
import { SectionNav } from '../../components/SectionNav';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Templates area: the template list, the builder and the two libraries. */
export function TemplatesLayout() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/templates`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionNav
        label="Templates"
        items={[
          { to: base, label: 'All templates', icon: LayoutList, end: true },
          { to: `${base}/new`, label: 'Create template', icon: SquarePlus },
          { to: `${base}/library`, label: 'Meta library', icon: Library },
          { to: `${base}/community`, label: 'Community library', icon: BookOpen },
        ]}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
