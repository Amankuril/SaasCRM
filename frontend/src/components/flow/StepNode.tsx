import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import { createContext, memo, useContext } from 'react';
import type { FlowGraphNode } from '../../lib/api';
import { cn } from '../ui';
import { NODE_META, nodeOutputs, nodeSummary } from './meta';

export interface BuilderContextValue {
  issues: Map<string, string[]>;
  tagName: (id: string) => string;
  templateName: (id: string) => string;
  /** Node ids currently holding a live execution (from the runs list). */
  activeNodes: Set<string>;
}

export const BuilderContext = createContext<BuilderContextValue>({
  issues: new Map(),
  tagName: () => '',
  templateName: () => '',
  activeNodes: new Set(),
});

/** One card on the canvas: icon, title, summary, an input on top and labelled outputs below. */
export const StepNode = memo(function StepNode({ id, type, data, selected }: NodeProps) {
  const ctx = useContext(BuilderContext);
  const node = { type, data } as Pick<FlowGraphNode, 'type' | 'data'>;
  const meta = NODE_META[node.type];
  const outputs = nodeOutputs(node);
  const issues = ctx.issues.get(id);
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        'w-60 rounded-xl border bg-white text-left shadow-sm transition-shadow',
        selected ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-slate-200',
        issues && 'border-red-400 ring-2 ring-red-300/50',
      )}
    >
      {node.type !== 'trigger' && <Handle type="target" position={Position.Top} className="!size-3 !border-2 !border-white !bg-slate-400" />}
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <span className={cn('flex size-6 items-center justify-center rounded-md ring-1', meta.accent)}>
          <Icon className="size-3.5" />
        </span>
        <span className="text-xs font-semibold text-slate-800">{meta.label}</span>
        {ctx.activeNodes.has(id) && <span className="ml-auto size-2 animate-pulse rounded-full bg-emerald-500" title="Contacts are here right now" />}
        {issues && <AlertTriangle className="ml-auto size-3.5 text-red-500" />}
      </div>
      <p className="line-clamp-3 px-3 py-2 text-xs whitespace-pre-wrap text-slate-600">
        {nodeSummary(node, { tag: ctx.tagName, template: ctx.templateName })}
      </p>
      {issues && <p className="px-3 pb-2 text-[11px] text-red-600">{issues[0]}</p>}

      {outputs.length > 0 && (
        <div className={cn('flex border-t border-slate-100', outputs.length === 1 && 'justify-center')}>
          {outputs.map((o) => (
            <div key={o.id} className="relative flex-1 px-1 pt-1 pb-3 text-center">
              {o.label && <span className="block truncate text-[10px] font-medium text-slate-500">{o.label}</span>}
              <Handle
                type="source"
                id={o.id}
                position={Position.Bottom}
                className={cn('!size-3 !border-2 !border-white', o.id === 'no_reply' || o.id === 'false' ? '!bg-slate-400' : '!bg-brand-600')}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
