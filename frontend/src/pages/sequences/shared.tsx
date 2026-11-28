import type { ContactList, PipelineStage, SeqStep, SequenceStatus, SequenceTrigger, Tag } from '../../lib/api';
import { Badge } from '../../components/ui';

export const STATUS_BADGE: Record<SequenceStatus, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  active: { label: 'Active', tone: 'green' },
  paused: { label: 'Paused', tone: 'amber' },
  archived: { label: 'Archived', tone: 'gray' },
};

export function StatusBadge({ status }: { status: SequenceStatus }) {
  const b = STATUS_BADGE[status];
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

export const TRIGGER_OPTIONS: { value: NonNullable<SequenceTrigger['type']>; label: string; hint: string }[] = [
  { value: 'manual', label: 'Added manually or by API', hint: 'From a contact list, pasted numbers, or an API call' },
  { value: 'tag_added', label: 'A tag is added', hint: 'By a teammate, a chatbot, an automation or the API' },
  { value: 'lifecycle_changed', label: 'Moves to a lifecycle stage', hint: 'When a contact enters one of the stages' },
  { value: 'list_added', label: 'Added to a contact list', hint: 'When a number joins one of the lists' },
  { value: 'new_contact', label: 'New contact', hint: 'The first time a contact appears in Audience' },
  { value: 'field_changed', label: 'A custom field changes', hint: 'Gets any value, or one specific value' },
  { value: 'date_field', label: 'A date in a custom field', hint: 'N days before, on or after the date (birthdays, appointments)' },
  { value: 'inactive', label: 'Has gone quiet', hint: 'Chatted before, then nothing for N days' },
];

export const NEW_CONTACT_SOURCES = [
  { value: 'whatsapp_inbound', label: 'Messaged you on WhatsApp' },
  { value: 'api', label: 'Created by API' },
  { value: 'broadcast', label: 'Added to a broadcast list' },
  { value: 'google_sheets', label: 'Google Sheets' },
  { value: 'import', label: 'Imported' },
  { value: 'manual', label: 'Added by a teammate' },
];

const names = (ids: string[], items: { id: string; name: string }[] | undefined) =>
  ids.map((id) => items?.find((i) => i.id === id)?.name ?? 'deleted').join(', ');

/** "Tag VIP is added", "3 days before appointment, 09:00"… */
export function triggerSummary(t: SequenceTrigger, refs: { tags?: Tag[]; lists?: ContactList[]; stages?: PipelineStage[] } = {}): string {
  switch (t.type) {
    case 'manual':
      return 'Added manually or by API';
    case 'tag_added':
      return t.tagIds.length ? `Tag ${names(t.tagIds, refs.tags)} is added` : 'A tag is added';
    case 'lifecycle_changed':
      return t.stages.length ? `Moves to ${t.stages.map((k) => refs.stages?.find((s) => s.key === k)?.name ?? k).join(', ')}` : 'Moves to a stage';
    case 'list_added':
      return t.listIds.length ? `Added to ${names(t.listIds, refs.lists)}` : 'Added to a list';
    case 'new_contact':
      return t.sources.length ? `New contact (${t.sources.map((s) => NEW_CONTACT_SOURCES.find((x) => x.value === s)?.label.toLowerCase() ?? s).join(', ')})` : 'New contact';
    case 'field_changed':
      return t.fieldKey ? `${t.fieldKey} ${t.fieldOp === 'equals' ? `becomes "${t.fieldValue ?? ''}"` : 'changes'}` : 'A field changes';
    case 'date_field': {
      if (!t.fieldKey) return 'A date field';
      const when = t.direction === 'on' ? 'On' : `${t.offsetDays} day${t.offsetDays === 1 ? '' : 's'} ${t.direction}`;
      return `${when} ${t.fieldKey}${t.repeatYearly ? ' (yearly)' : ''}, ${t.time}`;
    }
    case 'inactive':
      return `Quiet for ${t.days} days`;
    default:
      return 'Not set';
  }
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000 } as const;

/** Labels like "Right away", "After 3 hours", "Day 3" for each step, counting waits before it. */
export function timingLabels(steps: SeqStep[]): Map<string, string> {
  const out = new Map<string, string>();
  let ms = 0;
  let dated: string | null = null;
  for (const s of steps) {
    if (s.type === 'wait') {
      ms += s.amount * UNIT_MS[s.unit];
      dated = null;
      continue;
    }
    if (s.type === 'wait_until_date') {
      dated = s.offsetDays === 0 ? `On the day, ${s.time}` : `${Math.abs(s.offsetDays)} day${Math.abs(s.offsetDays) === 1 ? '' : 's'} ${s.offsetDays < 0 ? 'before' : 'after'}, ${s.time}`;
      continue;
    }
    if (dated) out.set(s.id, dated);
    else if (ms === 0) out.set(s.id, 'Right away');
    else if (ms < 86_400_000) {
      const h = ms / 3_600_000;
      out.set(s.id, h < 1 ? `After ${Math.round(ms / 60_000)} min` : `After ${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`);
    } else out.set(s.id, `Day ${Math.floor(ms / 86_400_000) + 1}`);
  }
  return out;
}

export const OUTCOME_LABEL: Record<string, string> = {
  completed: 'Had every message',
  completed_goal: 'Reached the goal',
  stopped: 'Stop condition',
  dropped_replied: 'Replied',
  opted_out: 'Opted out',
  removed: 'Removed',
  archived: 'Sequence archived',
  delivery_failed: 'Not delivered',
  error: 'Error',
};

export const ENROLLMENT_BADGE = {
  in_progress: { label: 'In progress', tone: 'blue' },
  needs_attention: { label: 'Needs attention', tone: 'amber' },
  completed: { label: 'Completed', tone: 'green' },
  dropped: { label: 'Dropped', tone: 'gray' },
  error: { label: 'Error', tone: 'red' },
} as const;

let counter = 0;
export const newStepId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
