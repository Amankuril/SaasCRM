import type { Graph, Step } from './sequence.graph.js';

/**
 * Ready-made starting points for "New sequence". They set the trigger, dates,
 * goal and steps; the business then picks its own approved templates for each
 * message (templates are per WhatsApp account, so none are pre-filled).
 */
export interface StartingPoint {
  key: string;
  name: string;
  description: string;
  icon: string;
  trigger: Record<string, unknown>;
  dateMode?: 'none' | 'fixed' | 'per_contact';
  dateKey?: string;
  goal?: { type: string; tagNames?: string[] };
  rules?: Record<string, unknown>;
  /** Tags the trigger / goal refer to by name (created if missing). */
  triggerTagNames?: string[];
  graph: Graph;
  summary: string[];
}

let n = 0;
const id = (p: string) => `${p}${++n}`;
const msg = (note: string, extra: Partial<Step> = {}): Step => ({ id: id('m'), type: 'message', note, templateId: null, headerVariables: [], bodyVariables: [], mediaUrl: null, filter: [], freeIfWindowOpen: false, ...extra } as Step);
const wait = (amount: number, unit: 'minutes' | 'hours' | 'days' | 'weeks'): Step => ({ id: id('w'), type: 'wait', amount, unit });
const dated = (offsetDays: number, time: string): Step => ({ id: id('d'), type: 'wait_until_date', offsetDays, time });

const clean = (graph: { steps: Step[] }): Graph => graph;

export const STARTING_POINTS: StartingPoint[] = [
  {
    key: 'free_trial',
    name: 'Free trial onboarding',
    description: 'Welcome new trial users, show features, and nudge them before the trial ends.',
    icon: 'rocket',
    trigger: { type: 'manual' },
    dateMode: 'per_contact',
    dateKey: 'trial_ends_at',
    goal: { type: 'tag_added', tagNames: ['upgraded'] },
    graph: clean({ steps: [msg('Welcome'), wait(2, 'hours'), msg('First step'), wait(3, 'days'), msg('Features'), wait(2, 'days'), msg('Features (part 2)'), wait(2, 'days'), msg('Customer story'), dated(-3, '10:00'), msg('Trial ends in 3 days'), dated(-1, '10:00'), msg('Trial ends tomorrow'), dated(1, '10:00'), msg('Special offer')] }),
    summary: ['Joins by API or manually, with trial_ends_at', 'Now welcome, +2 h first step, day 3 and 5 features, day 7 story', '3 days and 1 day before the trial ends, then an offer', 'Goal: tag "upgraded"'],
  },
  {
    key: 'webinar',
    name: 'Webinar or event reminders',
    description: 'Confirm the booking, remind a week, a day and minutes before, then share the recording.',
    icon: 'presentation',
    trigger: { type: 'manual' },
    dateMode: 'fixed',
    rules: { stopOnReply: false },
    graph: clean({ steps: [msg('Booking confirmed'), dated(-7, '10:00'), msg('One week to go'), dated(-1, '18:00'), msg('Tomorrow'), dated(0, '18:30'), msg('Join link'), dated(1, '11:00'), msg('Recording')] }),
    summary: ['Joins by tag or manually; one date for everyone', 'Confirmed now; reminders 7 days and 1 day before', 'Join link on the day; recording the day after', 'Keeps going when people reply'],
  },
  {
    key: 'welcome',
    name: 'Welcome new contacts',
    description: 'Greet people who message you for the first time, then follow up with an offer.',
    icon: 'hand',
    trigger: { type: 'new_contact', sources: ['whatsapp_inbound'] },
    graph: clean({ steps: [msg('Welcome', { freeIfWindowOpen: true } as Partial<Step>), wait(3, 'days'), msg('Offer')] }),
    summary: ['Joins when someone messages you for the first time', 'Welcome right away (free inside the 24-hour window)', 'Offer on day 3'],
  },
  {
    key: 'birthday',
    name: 'Birthday wishes',
    description: 'Send a wish on their birthday every year, then a small gift offer.',
    icon: 'cake',
    trigger: { type: 'date_field', fieldKey: 'birthday', direction: 'on', offsetDays: 0, time: '09:00', repeatYearly: true },
    rules: { joinOnce: false, reentryDays: 300 },
    graph: clean({ steps: [msg('Happy birthday'), wait(4, 'days'), msg('Birthday offer')] }),
    summary: ['Joins on the "birthday" field date every year at 09:00', 'Wish on the day, offer 4 days later'],
  },
  {
    key: 'win_back',
    name: 'Win back quiet contacts',
    description: 'Reach out to people who have not messaged in a while.',
    icon: 'rotate',
    trigger: { type: 'inactive', days: 30, time: '10:00' },
    rules: { joinOnce: false, reentryDays: 60 },
    graph: clean({ steps: [msg('We miss you'), wait(4, 'days'), msg('Last offer')] }),
    summary: ['Joins after 30 days without a message from them', '"We miss you" now, a last offer on day 4'],
  },
  {
    key: 'appointment',
    name: 'Appointment reminders',
    description: 'Remind patients or customers the day before and on the morning of their appointment.',
    icon: 'calendar',
    trigger: { type: 'date_field', fieldKey: 'appointment', direction: 'before', offsetDays: 1, time: '09:00' },
    dateMode: 'per_contact',
    dateKey: 'appointment',
    rules: { stopOnReply: false, joinOnce: false, reentryDays: 0 },
    graph: clean({ steps: [dated(-1, '10:00'), msg('Reminder: tomorrow'), dated(0, '08:00'), msg('See you today')] }),
    summary: ['Joins a day before the "appointment" field date', 'Reminder the day before at 10:00 (Utility template)', '"See you today" at 08:00 on the day'],
  },
  {
    key: 'cart',
    name: 'Left something behind',
    description: 'Follow up on abandoned carts with the checkout link, then a discount.',
    icon: 'cart',
    trigger: { type: 'tag_added' },
    triggerTagNames: ['Cart left'],
    goal: { type: 'tag_added', tagNames: ['Paid'] },
    graph: clean({ steps: [msg('Checkout link'), wait(2, 'days'), msg('Discount')] }),
    summary: ['Joins when the tag "Cart left" is added', 'Checkout link now, discount on day 2', 'Goal: tag "Paid"'],
  },
];

/** Fresh step ids for every copy, so two sequences never share ids. */
export function freshGraph(graph: Graph): Graph {
  const copy = JSON.parse(JSON.stringify(graph)) as { steps: Step[] };
  const prefix = Math.random().toString(36).slice(2, 7);
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      s.id = `${prefix}_${s.id}`;
      if (s.type === 'branch') for (const w of s.ways) walk(w.steps);
    }
  };
  walk(copy.steps);
  return copy as Graph;
}
