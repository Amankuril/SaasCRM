import {
  Bot,
  CalendarCheck,
  CalendarClock,
  CircleCheckBig,
  ClipboardList,
  Clock,
  Contact,
  FileText,
  Flag,
  GitBranch,
  Images,
  Layers,
  Link2,
  List,
  ListChecks,
  MapPin,
  MapPinned,
  MessageCircleQuestion,
  MessageSquareText,
  MousePointerClick,
  PencilLine,
  Repeat,
  ShoppingBag,
  Star,
  Table2,
  Tags,
  Ticket,
  TimerOff,
  UserCog,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { FlowGraphNode, FlowNodeType } from '../../lib/api';

export interface NodeMeta {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for the node's accent. */
  accent: string;
  group: 'Trigger' | 'Messages' | 'Logic & Flow' | 'Advanced';
  /** Still runs in existing flows, but is no longer offered in the palette. */
  hidden?: boolean;
  defaults: () => Record<string, unknown>;
}

const uid = () => Math.random().toString(36).slice(2, 8);

const SKY = 'bg-sky-50 text-sky-700 ring-sky-200';
const VIOLET = 'bg-violet-50 text-violet-700 ring-violet-200';
const PINK = 'bg-pink-50 text-pink-700 ring-pink-200';
const ORANGE = 'bg-orange-50 text-orange-700 ring-orange-200';
const TEAL = 'bg-teal-50 text-teal-700 ring-teal-200';
const SLATE = 'bg-slate-100 text-slate-700 ring-slate-200';

/** Palette order follows the key order inside each group. */
export const NODE_META: Record<FlowNodeType, NodeMeta> = {
  trigger: {
    label: 'Trigger',
    description: 'What starts the flow',
    icon: Zap,
    accent: 'bg-amber-50 text-amber-700 ring-amber-200',
    group: 'Trigger',
    defaults: () => ({ event: 'keyword', keywords: [], match: 'exact' }),
  },

  // ---- Messages ----
  send_text: {
    label: 'Send Message',
    description: 'Free text (within 24h of their last message)',
    icon: MessageSquareText,
    accent: SKY,
    group: 'Messages',
    defaults: () => ({ text: '' }),
  },
  send_cta: {
    label: 'CTA URL Button',
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
    accent: PINK,
    group: 'Messages',
    defaults: () => ({ question: '', saveTo: 'custom.answer', validation: 'any', retryMessage: "That doesn't look right. Please try again.", timeoutMinutes: 1440 }),
  },
  send_template: {
    label: 'Template Msg',
    description: 'Approved template, works any time',
    icon: FileText,
    accent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    group: 'Messages',
    defaults: () => ({ templateId: '', headerVariables: [], bodyVariables: [] }),
  },
  send_form: {
    label: 'WhatsApp Flow/Form',
    description: 'WhatsApp form; waits for the submission',
    icon: ClipboardList,
    accent: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
    group: 'Messages',
    defaults: () => ({ formId: '', text: '', timeoutMinutes: 1440 }),
  },
  send_catalog: {
    label: 'Send Catalogue',
    description: 'Show your WhatsApp catalogue',
    icon: ShoppingBag,
    accent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    group: 'Messages',
    defaults: () => ({ text: 'Have a look at our catalogue.' }),
  },
  send_list: {
    label: 'Interactive List',
    description: 'Menu of up to 10 options, branch on the choice',
    icon: List,
    accent: VIOLET,
    group: 'Messages',
    defaults: () => ({ text: '', buttonText: 'View options', rows: [{ id: uid(), title: 'Option 1' }, { id: uid(), title: 'Option 2' }], timeoutMinutes: 1440 }),
  },
  send_media: {
    label: 'Media Carousel',
    description: 'Images, videos or documents, one after another',
    icon: Images,
    accent: SKY,
    group: 'Messages',
    defaults: () => ({ items: [{ mediaType: 'image', link: 'https://', caption: '' }] }),
  },
  send_location: {
    label: 'Location',
    description: 'Send a map pin',
    icon: MapPin,
    accent: 'bg-rose-50 text-rose-700 ring-rose-200',
    group: 'Messages',
    defaults: () => ({ latitude: null, longitude: null, name: '', address: '' }),
  },
  rating: {
    label: 'Feedback/Rating',
    description: 'Ask for a 1 to 5 star rating',
    icon: Star,
    accent: 'bg-yellow-50 text-yellow-700 ring-yellow-200',
    group: 'Messages',
    defaults: () => ({ question: 'How would you rate your experience with us?', saveAs: 'rating', timeoutMinutes: 1440 }),
  },
  send_contacts: {
    label: 'Contact List',
    description: 'Share contact cards',
    icon: Contact,
    accent: TEAL,
    group: 'Messages',
    defaults: () => ({ contacts: [{ name: '', phone: '', organization: '' }] }),
  },
  send_buttons: {
    label: 'Quick Reply',
    description: 'Up to 3 buttons, branch on the tap',
    icon: MousePointerClick,
    accent: VIOLET,
    group: 'Messages',
    defaults: () => ({ text: '', buttons: [{ id: uid(), title: 'Yes' }, { id: uid(), title: 'No' }], timeoutMinutes: 1440 }),
  },
  ask_address: {
    label: 'Address Msg',
    description: 'Ask for a delivery address',
    icon: MapPinned,
    accent: PINK,
    group: 'Messages',
    defaults: () => ({ text: 'Please share your delivery address.', country: 'IN', timeoutMinutes: 1440 }),
  },
  wait_reply: {
    label: 'No Response Sequence',
    description: "Follow up when the customer doesn't reply",
    icon: TimerOff,
    accent: SLATE,
    group: 'Messages',
    defaults: () => ({ amount: 30, unit: 'minutes' }),
  },

  // ---- Logic & Flow ----
  condition: {
    label: 'Condition',
    description: 'Branch on contact data or replies',
    icon: GitBranch,
    accent: ORANGE,
    group: 'Logic & Flow',
    defaults: () => ({ match: 'all', rules: [{ field: 'last_reply', op: 'contains', value: '' }] }),
  },
  delay: {
    label: 'Wait/Schedule',
    description: 'Pause before the next step',
    icon: Clock,
    accent: SLATE,
    group: 'Logic & Flow',
    defaults: () => ({ amount: 1, unit: 'hours' }),
  },
  time_check: {
    label: 'Time Check',
    description: 'Branch on business hours',
    icon: CalendarClock,
    accent: ORANGE,
    group: 'Logic & Flow',
    defaults: () => ({ days: [1, 2, 3, 4, 5, 6], from: '09:00', to: '18:00' }),
  },
  add_tags: {
    label: 'Add Tags',
    description: 'Tag the contact',
    icon: Tags,
    accent: TEAL,
    group: 'Logic & Flow',
    defaults: () => ({ tagIds: [] }),
  },
  loop: {
    label: 'Loop Items',
    description: 'Repeat steps for each item in a list',
    icon: Repeat,
    accent: ORANGE,
    group: 'Logic & Flow',
    defaults: () => ({ items: '' }),
  },
  book_appointment: {
    label: 'Book Appt.',
    description: 'Let the customer pick a date and time',
    icon: CalendarCheck,
    accent: 'bg-blue-50 text-blue-700 ring-blue-200',
    group: 'Logic & Flow',
    defaults: () => ({
      service: 'Appointment',
      durationMinutes: 30,
      datePrompt: 'Which day works for you?',
      timePrompt: 'Pick a time.',
      confirmation: 'Your appointment is booked for {{vars.appointment_date}} at {{vars.appointment_time}}.',
      daysAhead: 7,
      workingDays: [1, 2, 3, 4, 5, 6],
      slots: ['10:00', '11:00', '12:00', '15:00', '16:00', '17:00'],
      timeoutMinutes: 1440,
    }),
  },
  set_stage: {
    label: 'Set Stage',
    description: "Move the contact's lifecycle stage",
    icon: Layers,
    accent: TEAL,
    group: 'Logic & Flow',
    defaults: () => ({ stage: 'contacted' }),
  },
  set_field: {
    label: 'Custom Field',
    description: 'Save a value on the contact',
    icon: PencilLine,
    accent: TEAL,
    group: 'Logic & Flow',
    defaults: () => ({ field: 'custom.field', value: '{{last_reply}}' }),
  },
  create_ticket: {
    label: 'Smart Ticket',
    description: 'Open a ticket for your team',
    icon: Ticket,
    accent: 'bg-red-50 text-red-700 ring-red-200',
    group: 'Logic & Flow',
    defaults: () => ({ title: 'Request from {{contact.name}}', description: '{{last_reply}}', priority: 'medium' }),
  },
  exit: {
    label: 'End Flow',
    description: 'Finish the flow (optionally count a goal)',
    icon: Flag,
    accent: 'bg-slate-800 text-white ring-slate-700',
    group: 'Logic & Flow',
    defaults: () => ({ goal: '' }),
  },
  update_contact: {
    label: 'Update contact',
    description: 'Tags, stage, fields',
    icon: ListChecks,
    accent: TEAL,
    group: 'Logic & Flow',
    hidden: true,
    defaults: () => ({ actions: [{ type: 'set_stage', stage: 'contacted' }] }),
  },

  // ---- Advanced ----
  ai_answer: {
    label: 'AI Agent',
    description: 'Answer the last message from your knowledge base',
    icon: Bot,
    accent: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
    group: 'Advanced',
    defaults: () => ({ sendAnswer: true }),
  },
  handoff: {
    label: 'Transfer Agent',
    description: 'Send to the team inbox, pause the bot',
    icon: UserCog,
    accent: 'bg-red-50 text-red-700 ring-red-200',
    group: 'Advanced',
    defaults: () => ({ assigneeId: null, message: '', note: '' }),
  },
  resolve_chat: {
    label: 'Resolve Chat',
    description: 'Mark the conversation resolved and end',
    icon: CircleCheckBig,
    accent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    group: 'Advanced',
    defaults: () => ({ message: '' }),
  },
  http_request: {
    label: 'Webhook Request',
    description: 'Call your API or CRM and use the response',
    icon: Webhook,
    accent: 'bg-lime-50 text-lime-700 ring-lime-200',
    group: 'Advanced',
    defaults: () => ({ method: 'POST', url: 'https://', headers: [], body: '{\n  "phone": "{{contact.phone}}"\n}', saveResponse: [], timeoutSeconds: 10 }),
  },
  google_sheets: {
    label: 'Google Sheets',
    description: 'Add a row to a Google Sheet',
    icon: Table2,
    accent: 'bg-green-50 text-green-700 ring-green-200',
    group: 'Advanced',
    defaults: () => ({ googleAccountId: '', sheetUrl: '', tab: 'Sheet1', values: ['{{contact.name}}', '{{contact.phone}}'] }),
  },
};

export const PALETTE_GROUPS: NodeMeta['group'][] = ['Messages', 'Logic & Flow', 'Advanced'];

/** Step types offered in the palette for a group, in display order. */
export const paletteItems = (group: NodeMeta['group']) => (Object.keys(NODE_META) as FlowNodeType[]).filter((t) => NODE_META[t].group === group && !NODE_META[t].hidden);

const REPLY = [
  { id: 'answered', label: 'Answered' },
  { id: 'no_reply', label: 'No reply' },
];

/** Mirrors the backend's output handles for each node type. */
export function nodeOutputs(node: Pick<FlowGraphNode, 'type' | 'data'>): { id: string; label: string }[] {
  switch (node.type) {
    case 'send_buttons': {
      const buttons = (node.data.buttons as { id: string; title: string }[] | undefined) ?? [];
      return [...buttons.map((b) => ({ id: `btn:${b.id}`, label: b.title || 'Button' })), { id: 'no_reply', label: 'No reply' }];
    }
    case 'send_list': {
      const rows = (node.data.rows as { id: string; title: string }[] | undefined) ?? [];
      return [...rows.map((r) => ({ id: `row:${r.id}`, label: r.title || 'Option' })), { id: 'no_reply', label: 'No reply' }];
    }
    case 'ask':
    case 'rating':
    case 'ask_address':
      return REPLY;
    case 'wait_reply':
      return [
        { id: 'replied', label: 'Replied' },
        { id: 'no_reply', label: 'No reply' },
      ];
    case 'condition':
      return [
        { id: 'true', label: 'Yes' },
        { id: 'false', label: 'No' },
      ];
    case 'time_check':
      return [
        { id: 'true', label: 'Within hours' },
        { id: 'false', label: 'Outside' },
      ];
    case 'loop':
      return [
        { id: 'item', label: 'Each item' },
        { id: 'done', label: 'Done' },
      ];
    case 'book_appointment':
      return [
        { id: 'booked', label: 'Booked' },
        { id: 'no_reply', label: 'No reply' },
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
    case 'http_request':
    case 'google_sheets':
      return [
        { id: 'success', label: 'Success' },
        { id: 'failed', label: 'Failed' },
      ];
    case 'handoff':
    case 'exit':
    case 'resolve_chat':
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
  api: 'Started by API (POST /v1/flows/:id/runs)',
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
    case 'send_list':
    case 'send_catalog':
    case 'ask_address':
      return d.text || 'Write a message…';
    case 'send_template':
      return d.templateId ? names.template(d.templateId) : 'Choose a template…';
    case 'ask':
    case 'rating':
      return d.question || 'Write a question…';
    case 'send_form':
      return d.formId ? names.form(d.formId) : 'Choose a form…';
    case 'send_media':
      return `${d.items?.length ?? 0} media item(s)`;
    case 'send_location':
      return d.name || (d.latitude != null && d.longitude != null ? `${d.latitude}, ${d.longitude}` : 'Set the location…');
    case 'send_contacts':
      return (d.contacts ?? []).map((c: { name: string }) => c.name).filter(Boolean).join(', ') || 'Add a contact…';
    case 'wait_reply':
      return `Wait ${d.amount ?? '?'} ${d.unit ?? ''} for a reply`;
    case 'ai_answer':
      return d.sendAnswer === false ? 'Store answer in {{vars.ai_answer}}' : 'Reply with the AI answer';
    case 'http_request':
      return d.url && d.url !== 'https://' ? `${d.method ?? 'POST'} ${d.url}` : 'Enter the URL…';
    case 'condition':
      return `${d.rules?.length ?? 0} rule(s), match ${d.match === 'any' ? 'any' : 'all'}`;
    case 'delay':
      return `${d.amount ?? '?'} ${d.unit ?? ''}`;
    case 'time_check':
      return `${(d.days ?? []).map((n: number) => WEEKDAYS[n]).join(', ') || 'No days'} · ${d.from ?? '?'}–${d.to ?? '?'}`;
    case 'add_tags':
      return (d.tagIds ?? []).map((id: string) => names.tag(id)).join(', ') || 'Choose tags…';
    case 'set_stage':
      return d.stage ? `Stage: ${String(d.stage).replace(/_/g, ' ')}` : 'Choose a stage…';
    case 'set_field':
      return `${String(d.field ?? '').replace('custom.', '')} = ${d.value || '…'}`;
    case 'loop':
      return d.items || 'Enter the items…';
    case 'book_appointment':
      return `${d.service || 'Appointment'} · ${d.slots?.length ?? 0} slot(s) a day`;
    case 'create_ticket':
      return d.title || 'Enter the ticket title…';
    case 'resolve_chat':
      return d.message || 'Mark the chat resolved';
    case 'google_sheets':
      return d.sheetUrl ? `Add a row to "${d.tab || 'Sheet1'}"` : 'Paste the sheet link…';
    case 'update_contact':
      return `${d.actions?.length ?? 0} change(s)`;
    case 'handoff':
      return d.assigneeId ? 'Assign to a teammate' : 'Send to the team queue';
    case 'exit':
      return d.goal ? `Goal: ${d.goal}` : 'End of flow';
  }
}
