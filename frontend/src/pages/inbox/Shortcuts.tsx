import { Keyboard } from 'lucide-react';
import { Dialog } from '../../components/Dialog';

export const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous chat'],
  ['Esc', 'Close the open chat'],
  ['r', 'Write a reply'],
  ['n', 'Write an internal note'],
  ['e', 'Resolve the open chat'],
  ['s', 'Star or unstar the open chat'],
  ['/', 'In the reply box: insert a canned reply'],
  ['@', 'In a note: mention a teammate'],
  ['Enter', 'Send (Shift+Enter for a new line)'],
  ['?', 'Show these shortcuts'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog icon={<Keyboard className="size-5" />} title="Keyboard shortcuts" subtitle="Work through the inbox without the mouse" onClose={onClose}>
      <dl className="divide-y divide-slate-100 text-sm">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-slate-600">{what}</dt>
            <dd className="flex gap-1">
              {keys.split(' / ').map((k) => (
                <kbd key={k} className="min-w-7 rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-center font-mono text-xs text-slate-700 shadow-[0_1px_0_rgb(203_213_225)]">
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
