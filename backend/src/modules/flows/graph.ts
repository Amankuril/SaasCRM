import { z } from 'zod';

/**
 * Flow graph format (React Flow compatible). Nodes carry typed config in `data`;
 * edges connect a node's named output handle to the next node.
 *
 * Output handles per node type:
 *  - trigger, send_text, send_template, send_cta, update_contact, delay: "next"
 *  - send_buttons: "btn:<buttonId>" per button, plus "no_reply" (timeout)
 *  - ask: "answered", "no_reply"
 *  - send_form: "submitted", "no_reply"
 *  - condition: "true", "false"
 *  - ai_answer: "answered", "handoff"
 *  - handoff, exit: none (end of flow)
 */
export const NODE_TYPES = [
  'trigger',
  'send_text',
  'send_template',
  'send_buttons',
  'send_cta',
  'ask',
  'send_form',
  'condition',
  'delay',
  'update_contact',
  'ai_answer',
  'handoff',
  'exit',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Nodes that pause the execution: a cycle must pass through one of them. */
export const WAITING_NODES = new Set<NodeType>(['delay', 'ask', 'send_buttons', 'send_form']);

export const graphNodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const graphEdgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1),
  sourceHandle: z.string().nullish().transform((v) => v ?? 'next'),
  target: z.string().min(1),
});

/** Drafts may be incomplete; strict per-node checks run at publish time. */
export const graphSchema = z.object({
  nodes: z.array(graphNodeSchema).max(200, 'A flow can have at most 200 steps.'),
  edges: z.array(graphEdgeSchema).max(400),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;

// ---- Typed node configs (validated at publish) ----

const variableSpec = z.object({
  source: z.enum(['static', 'field']),
  value: z.string().trim().min(1),
  fallback: z.string().trim().max(500).default(''),
});

export const nodeConfigSchemas = {
  trigger: z
    .object({
      event: z.enum(['keyword', 'any_message', 'new_contact', 'tag_added', 'form_submitted']),
      keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      match: z.enum(['exact', 'contains']).default('exact'),
      tagId: z.string().nullish(),
      formId: z.string().nullish(),
    })
    .refine((t) => t.event !== 'keyword' || t.keywords.length > 0, { message: 'Add at least one keyword.', path: ['keywords'] })
    .refine((t) => t.event !== 'tag_added' || !!t.tagId, { message: 'Choose a tag.', path: ['tagId'] })
    .refine((t) => t.event !== 'form_submitted' || !!t.formId, { message: 'Choose a form.', path: ['formId'] }),
  send_text: z.object({ text: z.string().trim().min(1, 'Write a message.').max(4096) }),
  send_template: z.object({
    templateId: z.string().min(1, 'Choose a template.'),
    headerVariables: z.array(variableSpec).max(1).default([]),
    bodyVariables: z.array(variableSpec).max(50).default([]),
  }),
  send_buttons: z.object({
    text: z.string().trim().min(1, 'Write the message.').max(1024),
    header: z.string().trim().max(60).optional(),
    footer: z.string().trim().max(60).optional(),
    buttons: z
      .array(z.object({ id: z.string().min(1).max(64), title: z.string().trim().min(1, 'Name every button.').max(20, 'Button titles are at most 20 characters.') }))
      .min(1, 'Add at least one button.')
      .max(3, 'WhatsApp allows at most 3 reply buttons.')
      .refine((b) => new Set(b.map((x) => x.title.toLowerCase())).size === b.length, 'Button titles must be different.'),
    timeoutMinutes: z.number().int().min(1).max(7 * 24 * 60).default(24 * 60),
  }),
  send_cta: z.object({
    text: z.string().trim().min(1, 'Write the message.').max(1024),
    header: z.string().trim().max(60).optional(),
    footer: z.string().trim().max(60).optional(),
    buttonText: z.string().trim().min(1, 'Name the button.').max(20),
    url: z.string().url('Enter a full URL (https://…).').refine((u) => u.startsWith('https://'), 'Use an https:// link.'),
  }),
  ask: z.object({
    question: z.string().trim().min(1, 'Write the question.').max(1024),
    saveTo: z.string().regex(/^(name|email|custom\.[a-z0-9_]{1,40}|var\.[a-z0-9_]{1,40})$/, 'Choose where to save the answer.'),
    validation: z.enum(['any', 'email', 'number', 'phone']).default('any'),
    retryMessage: z.string().trim().max(500).default("That doesn't look right. Please try again."),
    timeoutMinutes: z.number().int().min(1).max(7 * 24 * 60).default(24 * 60),
  }),
  send_form: z.object({
    formId: z.string().min(1, 'Choose a form.'),
    text: z.string().trim().max(1024).default(''),
    timeoutMinutes: z.number().int().min(1).max(7 * 24 * 60).default(24 * 60),
  }),
  condition: z.object({
    match: z.enum(['all', 'any']).default('all'),
    rules: z
      .array(
        z.object({
          field: z.string().regex(/^(tag|stage|name|email|last_reply|consent|custom\.[a-z0-9_]{1,40}|var\.[a-z0-9_]{1,40})$/, 'Choose a field.'),
          op: z.enum(['equals', 'not_equals', 'contains', 'is_empty', 'not_empty', 'has', 'not_has']),
          value: z.string().max(500).default(''),
        }),
      )
      .min(1, 'Add at least one rule.')
      .max(10),
  }),
  delay: z.object({ amount: z.number().int().min(1).max(10_000), unit: z.enum(['minutes', 'hours', 'days']) }),
  update_contact: z.object({
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('add_tag'), tagId: z.string().min(1, 'Choose a tag.') }),
          z.object({ type: z.literal('remove_tag'), tagId: z.string().min(1, 'Choose a tag.') }),
          z.object({ type: z.literal('set_stage'), stage: z.enum(['new', 'contacted', 'qualified', 'follow_up', 'converted', 'lost']) }),
          z.object({ type: z.literal('set_field'), field: z.string().regex(/^(name|email|custom\.[a-z0-9_]{1,40})$/), value: z.string().max(500) }),
        ]),
      )
      .min(1, 'Add at least one change.')
      .max(10),
  }),
  ai_answer: z.object({
    // Send the AI's answer to the customer automatically (otherwise it's only stored in {{vars.ai_answer}}).
    sendAnswer: z.boolean().default(true),
  }),
  handoff: z.object({
    assigneeId: z.string().nullish(),
    message: z.string().trim().max(1024).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  exit: z.object({ goal: z.string().trim().max(80).optional() }),
} satisfies Record<NodeType, z.ZodTypeAny>;

export type NodeConfig<T extends NodeType> = z.infer<(typeof nodeConfigSchemas)[T]>;

export function outputHandles(node: GraphNode): string[] {
  switch (node.type) {
    case 'send_buttons': {
      const buttons = (node.data.buttons as { id: string }[] | undefined) ?? [];
      return [...buttons.map((b) => `btn:${b.id}`), 'no_reply'];
    }
    case 'ask':
      return ['answered', 'no_reply'];
    case 'send_form':
      return ['submitted', 'no_reply'];
    case 'condition':
      return ['true', 'false'];
    case 'ai_answer':
      return ['answered', 'handoff'];
    case 'handoff':
    case 'exit':
      return [];
    default:
      return ['next'];
  }
}

export function nextNodeId(graph: Graph, nodeId: string, handle: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

export const DEFAULT_GRAPH: Graph = {
  nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: [], match: 'exact' } }],
  edges: [],
};
