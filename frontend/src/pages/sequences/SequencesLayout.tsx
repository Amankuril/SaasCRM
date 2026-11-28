import { BookOpen, ListOrdered } from 'lucide-react';
import { Outlet, useMatch } from 'react-router';
import { SectionNav } from '../../components/SectionNav';
import { useWorkspace } from '../../layouts/workspaceContext';

/** Automation > Sequences: the list (and each sequence's pages) plus the Guide. */
export function SequencesLayout() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/sequences`;
  const onGuide = useMatch('/w/:workspaceId/sequences/guide');
  const onBuilder = useMatch('/w/:workspaceId/sequences/:sequenceId');
  const builder = onBuilder && !onGuide;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionNav
        label="Sequences"
        items={[
          { to: base, label: 'Sequences', icon: ListOrdered, active: !onGuide },
          { to: `${base}/guide`, label: 'Guide', icon: BookOpen, end: true },
        ]}
      />
      {builder ? (
        // The builder manages its own scrolling (sticky top bar and side panel).
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
