import { z } from 'zod';

/**
 * A sequence is a vertical list of steps. A branch holds up to 5 "ways", each with
 * its own steps; ways merge back after the branch. Steps are addressed by id, and
 * an enrollment remembers the id of the step it runs next.
 */

const id = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Bad step id.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

/** Where a template variable's value comes from. */
export const variableSchema = z.object({
  // contact: name | first_name | phone | email; field: custom field key; data: enrollment data key; today; text: fixed text.
  source: z.enum(['contact', 'field', 'data', 'today', 'text']),
  value: z.string().trim().max(500).default(''),
  fallback: z.string().trim().max(500).default(''),
});
export type Variable = z.infer<typeof variableSchema>;

export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), op: z.enum(['has', 'not_has']), tagId: z.string() }),
  z.object({ kind: z.literal('stage'), op: z.enum(['is', 'is_not']), stage: z.string().trim().min(1).max(60) }),
  z.object({ kind: z.literal('field'), key: z.string().trim().min(1).max(60), op: z.enum(['equals', 'not_equals', 'contains', 'is_set', 'not_set']), value: z.string().trim().max(500).default('') }),
  z.object({ kind: z.literal('data'), key: z.string().trim().min(1).max(60), op: z.enum(['equals', 'not_equals', 'contains', 'is_set', 'not_set']), value: z.string().trim().max(500).default('') }),
  // Branch-only: about this sequence's last message, or the contact's replies.
  z.object({ kind: z.literal('last_message'), op: z.enum(['read', 'delivered', 'not_read']) }),
  z.object({ kind: z.literal('replied'), op: z.enum(['replied', 'not_replied', 'contains']), value: z.string().trim().max(200).default('') }),
  z.object({ kind: z.literal('split'), percent: z.number().int().min(1).max(99) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

const messageStep = z.object({
  id,
  type: z.literal('message'),
  // The author's own note for this message ("Welcome", "Offer"); contacts never see it.
  note: z.string().trim().max(120).default(''),
  templateId: z.string().nullable().default(null),
  headerVariables: z.array(variableSchema).max(1).default([]),
  bodyVariables: z.array(variableSchema).max(20).default([]),
  // A public https link that replaces the template's sample header image/video/document.
  mediaUrl: z.string().trim().url().max(1000).nullable().default(null),
  // Contacts that do not match skip this message and move to the next step.
  filter: z.array(conditionSchema).max(10).default([]),
  // Inside the 24h window, send the template text as a normal (free) message instead.
  freeIfWindowOpen: z.boolean().default(false),
});

const waitStep = z.object({
  id,
  type: z.literal('wait'),
  amount: z.number().int().min(1).max(10_000),
  unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
});

const waitUntilDateStep = z.object({
  id,
  type: z.literal('wait_until_date'),
  // Days relative to the reminder date: -1 = one day before, 0 = on the day, 2 = two days after.
  offsetDays: z.number().int().min(-365).max(365),
  time,
});

const actionStep = z.discriminatedUnion('action', [
  z.object({ id, type: z.literal('action'), action: z.literal('add_tag'), tagId: z.string() }),
  z.object({ id, type: z.literal('action'), action: z.literal('remove_tag'), tagId: z.string() }),
  z.object({ id, type: z.literal('action'), action: z.literal('set_lifecycle'), stage: z.string().trim().min(1).max(60) }),
  z.object({ id, type: z.literal('action'), action: z.literal('add_to_list'), listId: z.string() }),
  z.object({ id, type: z.literal('action'), action: z.literal('start_sequence'), sequenceId: z.string() }),
  z.object({ id, type: z.literal('action'), action: z.literal('assign_chat'), userId: z.string().nullable().default(null) }),
  z.object({ id, type: z.literal('action'), action: z.literal('webhook'), url: z.string().trim().url().max(1000), secret: z.string().max(200).nullable().default(null) }),
]);

export type MessageStep = z.infer<typeof messageStep>;
export type WaitStep = z.infer<typeof waitStep>;
export type WaitUntilDateStep = z.infer<typeof waitUntilDateStep>;
export type ActionStep = z.infer<typeof actionStep>;
export interface BranchWay {
  id: string;
  label: string;
  conditions: Condition[];
  steps: Step[];
}
export interface BranchStep {
  id: string;
  type: 'branch';
  ways: BranchWay[];
}
export type Step = MessageStep | WaitStep | WaitUntilDateStep | ActionStep | BranchStep;

export const MAX_BRANCH_DEPTH = 2;
export const MAX_STEPS = 60;

function stepsSchema(depth: number): z.ZodType<Step[]> {
  const branch: z.ZodType<BranchStep> = z.object({
    id,
    type: z.literal('branch'),
    ways: z
      .array(
        z.object({
          id,
          label: z.string().trim().max(60).default(''),
          conditions: z.array(conditionSchema).max(10).default([]),
          steps: z.lazy(() => (depth < MAX_BRANCH_DEPTH ? stepsSchema(depth + 1) : z.array(z.union([messageStep, waitStep, waitUntilDateStep, actionStep])).max(MAX_STEPS))),
        }),
      )
      .min(2, 'A branch needs at least 2 ways.')
      .max(5, 'A branch can have at most 5 ways.'),
  }) as z.ZodType<BranchStep>;
  return z.array(z.union([messageStep, waitStep, waitUntilDateStep, actionStep, branch])).max(MAX_STEPS) as z.ZodType<Step[]>;
}

export const graphSchema = z.object({ steps: stepsSchema(1) });
export type Graph = { steps: Step[] };

// ---- navigation ----

export interface Compiled {
  first: string | null;
  steps: Map<string, Step>;
  /** The step after this one when nothing branches (end of a way = the step after its branch). */
  next: Map<string, string | null>;
  /** Wait/date steps before each step id, for labels like "Day 3". */
  order: string[];
}

export function compile(graph: Graph): Compiled {
  const steps = new Map<string, Step>();
  const next = new Map<string, string | null>();
  const order: string[] = [];
  const walk = (list: Step[], after: string | null) => {
    list.forEach((step, i) => {
      if (steps.has(step.id)) throw new Error(`Duplicate step id ${step.id}`);
      steps.set(step.id, step);
      order.push(step.id);
      const following = list[i + 1]?.id ?? after;
      next.set(step.id, following);
      if (step.type === 'branch') for (const way of step.ways) walk(way.steps, following);
    });
  };
  walk(graph.steps, null);
  return { first: graph.steps[0]?.id ?? null, steps, next, order };
}

/** Every step in the graph, depth first. */
export function allSteps(graph: Graph): Step[] {
  return [...compile(graph).steps.values()];
}

export function waitMs(step: WaitStep): number {
  const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000 }[step.unit];
  return step.amount * unit;
}

/** Stable 0–99 bucket for a contact, so a split test always puts them in the same way. */
export function splitBucket(contactId: string, stepId: string): number {
  let h = 2166136261;
  for (const ch of `${contactId}:${stepId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}
