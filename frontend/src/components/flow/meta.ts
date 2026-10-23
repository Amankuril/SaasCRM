import { Bot, ClipboardList, Clock, Flag, GitBranch, Link2, ListChecks, MessageCircleQuestion, MessageSquareText, MousePointerClick, FileText, UserCog, Zap, type LucideIcon } from 'lucide-react';
import type { FlowGraphNode, FlowNodeType } from '../../lib/api';

export interface NodeMeta {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for the node's accent. */
  accent: string;
  group: 'Trigger' | 'Messages' | 'Logic' | 'Actions';
  defaults: () => Record<string, unknown>;
}

const uid = () => Math.random().toString(36).slice(2, 8);

export const NODE_META: Record<FlowNodeType, NodeMeta> = {
  trigger: {
    label: 'Trigger',
    description: 'What starts the flow',
    icon: Zap,
    accent: 'bg-amber-50 text-amber-700 ring-amber-200',
    group: 'Trigger',
    defaults: () => ({ event: 'keyword', keywords: [], match: 'exact' }),
  },
  send_text: {
    label: 'Send message',
    description: 'Free text (within 24h of their last message)',
    icon: MessageSquareText,
    accent: 'bg-sky-50 text-sky-700 ring-sky-200',
    group: 'Messages',
    defaults: () => ({ text: '' }),
  },
  send_template: {
    label: 'Template message',
    description: 'Approved template, works any time',
    icon: FileText,
    accent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    group: 'Messages',
    defaults: () => ({ templateId: '', headerVariables: [], bodyVariables: [] }),
  },
  send_buttons: {
    label: 'Reply buttons',
    description: 'Up to 3 buttons, branch on the tap',
    icon: MousePointerClick,
    accent: 'bg-violet-50 text-violet-700 ring-violet-200',
    group: 'Messages',
    defaults: () => ({ text: '', buttons: [{ id: uid(), title: 'Yes' }, { id: uid(), title: 'No' }], timeoutMinutes: 1440 }),
  },
  send_cta: {
    label: 'CTA URL button',
    description: 'Message with a link button',
    icon: Link2,
    accent: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    group: 'Messages',
    defaults: () => ({ text: '', buttonText: '', url: 'https://' }),
  },
  ask: {
    label: 'Question',
    description: 'Ask and save the answer',
    icon: MessageCircleQuestion,
    accent: 'bg-pink-50 text-pink-700 ring-pink-200',
    group: 'Messages',
    defaults: () => ({ question: '', saveTo: 'custom.answer', validation: 'any', retryMessage: "That doesn't look right. Please try again.", timeoutMinutes: 1440 }),
  },
  send_form: {
    label: 'Send form',
    description: 'WhatsApp form; waits for the submission',
    icon: ClipboardList,
    accent: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
    group: 'Messages',
    defaults: () => ({ formId: '', text: '', timeoutMinutes: 1440 }),
  },
  ai_answer: {
    label: 'AI answer',
    description: 'Answer the last message from your knowledge base',
    icon: Bot,
    accent: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
    group: 'Logic',
    defaults: () => ({ sendAnswer: true }),
  },
  condition: {
    label: 'Condition',
    description: 'Branch on contact data or replies',
    icon: GitBranch,
    accent: 'bg-orange-50 text-orange-700 ring-orange-200',
    group: 'Logic',
    defaults: () => ({ match: 'all', rules: [{ field: 'last_reply', op: 'contains', value: '' }] }),
  },
  delay: {
    label: 'Wait / delay',
    description: 'Pause before the next step',
    icon: Clock,
    accent: 'bg-slate-100 text-slate-700 ring-slate-200',
    group: 'Logic',
    defaults: () => ({ amount: 1, unit: 'hours' }),
  },
  update_contact: {
    label: 'Update contact',
    description: 'Tags, stage, fields',
    icon: ListChecks,
    accent: 'bg-teal-50 text-teal-700 ring-teal-200',
    group: 'Actions',
    defaults: () => ({ actions: [{ type: 'set_stage', stage: 'contacted' }] }),
  },
  handoff: {
    label: 'Human handoff',
    description: 'Send to the team inbox, pause the bot',
    icon: UserCog,
    accent: 'bg-red-50 text-red-700 ring-red-200',
    group: 'Actions',
    defaults: () => ({ assigneeId: null, message: '', note: '' }),
  },
  exit: {
    label: 'End / goal',
    description: 'Finish the flow',
    icon: Flag,
    accent: 'bg-slate-800 text-white ring-slate-700',
    group: 'Actions',
    defaults: () => ({ goal: '' }),
  },
};

export const PALETTE_GROUPS: NodeMeta['group'][] = ['Messages', 'Logic', 'Actions'];

/** Mirrors the backend's output handles for each node type. */
export function nodeOutputs(node: Pick<FlowGraphNode, 'type' | 'data'>): { id: string; label: string }[] {
  switch (node.type) {
    case 'send_buttons': {
      const buttons = (node.data.buttons as { id: string; title: string }[] | undefined) ?? [];
      return [...buttons.map((b) => ({ id: `btn:${b.id}`, label: b.title || 'Button' })), { id: 'no_reply', label: 'No reply' }];
    }
    case 'ask':
      return [
        { id: 'answered', label: 'Answered' },
        { id: 'no_reply', label: 'No reply' },
      ];
    case 'condition':
      return [
        { id: 'true', label: 'Yes' },
        { id: 'false', label: 'No' },
      ];
    case 'send_form':
      return [
        { id: 'submitted', label: 'Submitted' },
        { id: 'no_reply', label: 'No reply' },
      ];
    case 'ai_answer':
      return [
        { id: 'answered', label: 'Answered' },
        { id: 'handoff', label: 'Needs human' },
      ];
    case 'handoff':
    case 'exit':
      return [];
    default:
      return [{ id: 'next', label: '' }];
  }
}

const TRIGGER_LABEL: Record<string, string> = {
  keyword: 'Keyword',
  any_message: 'Any incoming message',
  new_contact: 'First message from a new contact',
  tag_added: 'Tag added to contact',
  form_submitted: 'Form submitted',
};

/** One-line description shown on the canvas card. */
export function nodeSummary(
  node: Pick<FlowGraphNode, 'type' | 'data'>,
  names: { tag: (id: string) => string; template: (id: string) => string; form: (id: string) => string },
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = node.data as Record<string, any>;
  switch (node.type) {
    case 'trigger':
      if (d.event === 'keyword') return d.keywords?.length ? `Keyword: ${d.keywords.join(', ')}` : 'Keyword: (none yet)';
      if (d.event === 'tag_added') return `Tag added: ${d.tagId ? names.tag(d.tagId) : '(choose a tag)'}`;
      if (d.event === 'form_submitted') return `Form submitted: ${d.formId ? names.form(d.formId) : '(choose a form)'}`;
      return TRIGGER_LABEL[d.event] ?? 'Choose a trigger';
    case 'send_text':
    case 'send_buttons':
    case 'send_cta':
      return d.text || 'Write a message…';
    case 'send_template':
      return d.templateId ? names.template(d.templateId) : 'Choose a template…';
    case 'ask':
      return d.question || 'Write a question…';
    case 'send_form':
      return d.formId ? names.form(d.formId) : 'Choose a form…';
    case 'ai_answer':
      return d.sendAnswer === false ? 'Store answer in {{vars.ai_answer}}' : 'Reply with the AI answer';
    case 'condition':
      return `${d.rules?.length ?? 0} rule(s), match ${d.match === 'any' ? 'any' : 'all'}`;
    case 'delay':
      return `${d.amount ?? '?'} ${d.unit ?? ''}`;
    case 'update_contact':
      return `${d.actions?.length ?? 0} change(s)`;
    case 'handoff':
      return d.assigneeId ? 'Assign to a teammate' : 'Send to the team queue';
    case 'exit':
      return d.goal ? `Goal: ${d.goal}` : 'End of flow';
  }
}
