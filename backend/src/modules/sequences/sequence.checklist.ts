import type { Types } from 'mongoose';
import { MessageTemplate } from '../templates/template.model.js';
import { sendRequirements } from '../templates/templateSend.js';
import { allSteps, graphSchema, type Graph, type MessageStep } from './sequence.graph.js';
import type { SequenceDoc } from './sequence.model.js';

/** One open item on the builder's "Things left" list. `stepId` lets the UI jump to it. */
export interface ChecklistItem {
  key: string;
  message: string;
  stepId?: string;
  /** Only blocks publishing (a test run can still go). */
  publishOnly?: boolean;
}

const ALLOWED_CATEGORIES = ['MARKETING', 'UTILITY'];

/**
 * Everything that must be true before a sequence can go live (and, except for
 * trigger items, before a test run). Empty list = ready.
 */
export async function checklist(seq: SequenceDoc, workspaceId: Types.ObjectId): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  const add = (key: string, message: string, extra: Partial<ChecklistItem> = {}) => items.push({ key, message, ...extra });

  // ---- who joins ----
  const t = seq.trigger;
  if (!t?.type) add('trigger', 'Choose who joins this sequence.', { publishOnly: true });
  else if (t.type === 'tag_added' && !t.tagIds?.length) add('trigger', 'Choose at least one tag for "Tag is added".', { publishOnly: true });
  else if (t.type === 'lifecycle_changed' && !t.stages?.length) add('trigger', 'Choose at least one lifecycle stage.', { publishOnly: true });
  else if (t.type === 'list_added' && !t.listIds?.length) add('trigger', 'Choose at least one contact list.', { publishOnly: true });
  else if ((t.type === 'field_changed' || t.type === 'date_field') && !t.fieldKey) add('trigger', 'Choose the custom field.', { publishOnly: true });
  else if (t.type === 'field_changed' && t.fieldOp === 'equals' && !t.fieldValue) add('trigger', 'Enter the value the field must get.', { publishOnly: true });
  else if (t.type === 'inactive' && !(t.days > 0)) add('trigger', 'Enter after how many quiet days contacts join.', { publishOnly: true });

  // ---- steps ----
  const parsed = graphSchema.safeParse(seq.draftGraph);
  if (!parsed.success) {
    add('steps', 'Some steps are incomplete. Open each step and fill it in.');
    return items;
  }
  const graph = parsed.data as Graph;
  const steps = allSteps(graph);
  const messages = steps.filter((s): s is MessageStep => s.type === 'message');
  if (!messages.length) add('steps', 'Add at least one message.');

  const templateIds = messages.map((m) => m.templateId).filter((v): v is string => !!v && /^[a-f0-9]{24}$/i.test(v));
  const templates = await MessageTemplate.find({ workspaceId, _id: { $in: templateIds } }).lean();
  messages.forEach((m, i) => {
    const label = m.note ? `"${m.note}"` : `Message ${i + 1}`;
    const template = templates.find((tpl) => String(tpl._id) === m.templateId);
    if (!m.templateId || !template) return add('template', `${label}: choose a template.`, { stepId: m.id });
    if (template.status !== 'APPROVED') return add('template', `${label}: template "${template.name}" is not approved yet.`, { stepId: m.id });
    if (!ALLOWED_CATEGORIES.includes(String(template.category).toUpperCase())) return add('template', `${label}: use a Marketing or Utility template.`, { stepId: m.id });
    const req = sendRequirements(template.components as never);
    if (req.buttons.length || req.cards.length || req.products || req.otp || req.headerLocation || req.offer) {
      return add('template', `${label}: "${template.name}" needs values sequences cannot fill yet (button links, cards, products or a location). Choose a simpler template.`, { stepId: m.id });
    }
    if (m.headerVariables.length !== req.header || m.bodyVariables.length !== req.body) return add('variables', `${label}: map every variable of the template.`, { stepId: m.id });
    const blank = [...m.headerVariables, ...m.bodyVariables].some((v) => v.source !== 'today' && !v.value.trim());
    if (blank) return add('variables', `${label}: some variables have no value chosen.`, { stepId: m.id });
    if (req.headerMedia && !m.mediaUrl) add('media', `${label}: add a link to the header ${req.headerMedia.toLowerCase()}.`, { stepId: m.id });
  });

  for (const s of steps) {
    if (s.type === 'action') {
      const missing =
        ((s.action === 'add_tag' || s.action === 'remove_tag') && !s.tagId) ||
        (s.action === 'add_to_list' && !s.listId) ||
        (s.action === 'start_sequence' && !s.sequenceId) ||
        (s.action === 'set_lifecycle' && !s.stage);
      if (missing) add('action', 'An action step is not set up yet.', { stepId: s.id });
      if (s.action === 'start_sequence' && s.sequenceId === String(seq._id)) add('action', 'A sequence cannot start itself.', { stepId: s.id });
    }
    if (s.type === 'branch') {
      const last = s.ways[s.ways.length - 1];
      if (last && last.conditions.length) add('branch', 'The last way of a branch must be "Everyone else" (no conditions).', { stepId: s.id });
      if (s.ways.slice(0, -1).some((w) => !w.conditions.length)) add('branch', 'Every way except the last needs a condition.', { stepId: s.id });
      const repliesUsed = s.ways.some((w) => w.conditions.some((c) => c.kind === 'replied'));
      if (repliesUsed && seq.rules?.stopOnReply) add('stop_on_reply', 'A branch checks replies: turn off "Stop when contact replies" in Sending rules.', { stepId: s.id });
    }
  }

  // ---- dates ----
  if (steps.some((s) => s.type === 'wait_until_date')) {
    if (seq.dateMode === 'none') add('dates', 'Dated steps need a date: set "Dates for reminders".');
    else if (seq.dateMode === 'fixed' && !seq.fixedDate) add('dates', 'Pick the date for reminders.');
    else if (seq.dateMode === 'per_contact' && !seq.dateKey) add('dates', 'Choose which data key or field holds each contact\'s date.');
  }

  // ---- goal / stop ----
  for (const rule of [seq.goal, ...(seq.stopConditions ?? [])]) {
    if (!rule || rule.type === 'none') continue;
    if (rule.type === 'tag_added' && !rule.tagIds?.length) add('goal', 'Choose the tag for the goal or stop condition.');
    if (rule.type === 'lifecycle' && !rule.stages?.length) add('goal', 'Choose the stage for the goal or stop condition.');
  }
  return items;
}
