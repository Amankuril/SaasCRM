import { ClipboardList, Headset, MessageCircleQuestion, Star, type LucideIcon } from 'lucide-react';
import type { FlowGraph } from '../../lib/api';

export interface FlowTemplate {
  key: string;
  name: string;
  description: string;
  icon: LucideIcon;
  graph: () => FlowGraph;
}

const edge = (source: string, handle: string, target: string) => ({ id: `${source}-${handle}-${target}`, source, sourceHandle: handle, target });

/** Ready-made automations offered under "Browse Templates". Each opens as an editable draft. */
export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    key: 'welcome',
    name: 'Welcome menu',
    description: 'Greets new customers and lets them pick Sales or Support with buttons.',
    icon: Headset,
    graph: () => ({
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: ['hi', 'hello'], match: 'exact' } },
        { id: 'menu', type: 'send_buttons', position: { x: 0, y: 160 }, data: { text: 'Hi {{contact.name}}! How can we help you today?', buttons: [{ id: 'sales', title: 'Sales' }, { id: 'support', title: 'Support' }], timeoutMinutes: 1440 } },
        { id: 'sales', type: 'send_text', position: { x: -220, y: 380 }, data: { text: 'Great! Tell us what you are looking for and our sales team will get back to you shortly.' } },
        { id: 'handoff', type: 'handoff', position: { x: 220, y: 380 }, data: { assigneeId: null, message: 'Connecting you to our support team…', note: 'Customer asked for support from the welcome menu.' } },
        { id: 'end', type: 'exit', position: { x: -220, y: 560 }, data: { goal: 'Sales enquiry' } },
      ],
      edges: [edge('trigger', 'next', 'menu'), edge('menu', 'btn:sales', 'sales'), edge('menu', 'btn:support', 'handoff'), edge('sales', 'next', 'end')],
    }),
  },
  {
    key: 'lead',
    name: 'Lead capture',
    description: 'Asks for name and email, saves them on the contact and hands over to your team.',
    icon: ClipboardList,
    graph: () => ({
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: ['pricing', 'demo'], match: 'contains' } },
        { id: 'name', type: 'ask', position: { x: 0, y: 160 }, data: { question: 'Happy to help! May I know your name?', saveTo: 'name', validation: 'any', retryMessage: "That doesn't look right. Please try again.", timeoutMinutes: 1440 } },
        { id: 'email', type: 'ask', position: { x: 0, y: 360 }, data: { question: 'Thanks {{contact.name}}. What is your email address?', saveTo: 'email', validation: 'email', retryMessage: 'Please enter a valid email address.', timeoutMinutes: 1440 } },
        { id: 'handoff', type: 'handoff', position: { x: 0, y: 560 }, data: { assigneeId: null, message: 'Thank you! Our team will contact you shortly.', note: 'New lead captured by the Lead capture automation.' } },
      ],
      edges: [edge('trigger', 'next', 'name'), edge('name', 'answered', 'email'), edge('email', 'answered', 'handoff')],
    }),
  },
  {
    key: 'feedback',
    name: 'Feedback collector',
    description: 'Asks customers how their experience was and thanks them for the answer.',
    icon: Star,
    graph: () => ({
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: ['feedback'], match: 'exact' } },
        { id: 'rate', type: 'send_buttons', position: { x: 0, y: 160 }, data: { text: 'How was your experience with us?', buttons: [{ id: 'good', title: 'Great' }, { id: 'ok', title: 'Okay' }, { id: 'bad', title: 'Not good' }], timeoutMinutes: 1440 } },
        { id: 'thanks', type: 'send_text', position: { x: -220, y: 380 }, data: { text: 'Thank you! We are glad you liked it.' } },
        { id: 'why', type: 'ask', position: { x: 220, y: 380 }, data: { question: 'Sorry to hear that. What could we do better?', saveTo: 'var.feedback', validation: 'any', retryMessage: 'Please tell us a little more.', timeoutMinutes: 1440 } },
        { id: 'end', type: 'exit', position: { x: 220, y: 580 }, data: { goal: 'Feedback collected' } },
      ],
      edges: [edge('trigger', 'next', 'rate'), edge('rate', 'btn:good', 'thanks'), edge('rate', 'btn:ok', 'thanks'), edge('rate', 'btn:bad', 'why'), edge('why', 'answered', 'end')],
    }),
  },
  {
    key: 'faq',
    name: 'FAQ auto-reply',
    description: 'Replies to a common question instantly and offers to talk to a person.',
    icon: MessageCircleQuestion,
    graph: () => ({
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: ['timing', 'hours'], match: 'contains' } },
        { id: 'answer', type: 'send_buttons', position: { x: 0, y: 160 }, data: { text: 'We are open Monday to Saturday, 10 AM to 7 PM. Anything else?', buttons: [{ id: 'agent', title: 'Talk to us' }, { id: 'done', title: 'No, thanks' }], timeoutMinutes: 60 } },
        { id: 'handoff', type: 'handoff', position: { x: -220, y: 380 }, data: { assigneeId: null, message: 'Sure, a teammate will reply shortly.', note: '' } },
        { id: 'end', type: 'exit', position: { x: 220, y: 380 }, data: { goal: 'FAQ answered' } },
      ],
      edges: [edge('trigger', 'next', 'answer'), edge('answer', 'btn:agent', 'handoff'), edge('answer', 'btn:done', 'end')],
    }),
  },
];
