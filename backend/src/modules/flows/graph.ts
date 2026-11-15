import { z } from 'zod';
import { templateExtrasSchema } from '../templates/templateSend.js';

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
 *  - http_request: "success", "failed"
 *  - handoff, exit, resolve_chat: none (end of flow)
 *  - send_list: "row:<rowId>" per row, plus "no_reply"
 *  - rating, ask_address: "answered", "no_reply"
 *  - wait_reply: "replied", "no_reply"
 *  - time_check: "true", "false"
 *  - loop: "item" (once per item), "done"
 *  - book_appointment: "booked", "no_reply"
 *  - google_sheets: "success", "failed"
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
  'http_request',
  'handoff',
  'exit',
  // Messages
  'send_list',
  'send_media',
  'send_location',
  'send_contacts',
  'send_catalog',
  'rating',
  'ask_address',
  'wait_reply',
  // Logic & flow
  'time_check',
  'add_tags',
  'set_stage',
  'set_field',
  'loop',
  'book_appointment',
  'create_ticket',
  // Advanced
  'resolve_chat',
  'google_sheets',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Nodes that pause the execution: a cycle must pass through one of them. */
export const WAITING_NODES = new Set<NodeType>(['delay', 'ask', 'send_buttons', 'send_form', 'send_list', 'rating', 'ask_address', 'wait_reply', 'book_appointment']);

/** "Loop Items" repeats its body once per item, at most this many times. */
export const LOOP_MAX_ITEMS = 20;

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

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'user-agent']);

const variableSpec = z.object({
  source: z.enum(['static', 'field']),
  value: z.string().trim().min(1),
  fallback: z.string().trim().max(500).default(''),
});

const timeoutMinutes = z.number().int().min(1).max(7 * 24 * 60).default(24 * 60);
const varName = z.string().regex(/^[a-z0-9_]{1,40}$/, 'Variable names use lowercase letters, numbers and underscores.');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 09:30.');

export const nodeConfigSchemas = {
  trigger: z
    .object({
      // `api`: started only through POST /api/v1/flows/:id/runs.
      event: z.enum(['keyword', 'any_message', 'new_contact', 'tag_added', 'form_submitted', 'api']),
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
    buttonVariables: z.array(variableSpec).max(10).default([]),
    templateExtras: templateExtrasSchema.default({}),
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
          z.object({ type: z.literal('set_stage'), stage: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Choose a stage.') }),
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
  http_request: z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
      // {{placeholders}} are allowed in the path and query, not in the scheme or host.
      url: z
        .string()
        .trim()
        .min(1, 'Enter the URL.')
        .max(2000)
        .regex(/^https?:\/\/[^/{}\s?#]+([/?#][^\s]*)?$/, 'Enter a full URL (https://…). The host cannot contain {{placeholders}}.'),
      headers: z
        .array(
          z.object({
            key: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9-]{1,64}$/, 'Header names use letters, digits and "-".')
              .refine((k) => !FORBIDDEN_HEADERS.has(k.toLowerCase()), 'This header is set automatically.'),
            value: z.string().max(2000),
          }),
        )
        .max(10)
        .default([]),
      body: z.string().max(10_000).default(''),
      // Copy values from a JSON response into {{vars.<var>}}, e.g. path "data.customer.id".
      saveResponse: z
        .array(
          z.object({
            path: z.string().trim().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+|\[\d+\])*$/, 'Use a path like data.items[0].name'),
            var: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Variable names use lowercase letters, numbers and underscores.'),
          }),
        )
        .max(10)
        .default([]),
      timeoutSeconds: z.number().int().min(1).max(15).default(10),
    })
    .refine((c) => !(c.method === 'GET' || c.method === 'DELETE') || !c.body.trim(), { message: 'GET and DELETE requests cannot have a body.', path: ['body'] }),
  handoff: z.object({
    assigneeId: z.string().nullish(),
    message: z.string().trim().max(1024).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  exit: z.object({ goal: z.string().trim().max(80).optional() }),
  send_list: z.object({
    text: z.string().trim().min(1, 'Write the message.').max(1024),
    header: z.string().trim().max(60).optional(),
    footer: z.string().trim().max(60).optional(),
    buttonText: z.string().trim().min(1, 'Name the menu button.').max(20, 'The menu button is at most 20 characters.'),
    rows: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          title: z.string().trim().min(1, 'Name every option.').max(24, 'Option titles are at most 24 characters.'),
          description: z.string().trim().max(72).optional(),
        }),
      )
      .min(1, 'Add at least one option.')
      .max(10, 'WhatsApp allows at most 10 options in a list.')
      .refine((r) => new Set(r.map((x) => x.title.toLowerCase())).size === r.length, 'Option titles must be different.'),
    timeoutMinutes,
  }),
  send_media: z.object({
    items: z
      .array(
        z.object({
          mediaType: z.enum(['image', 'video', 'document']),
          link: z.string().trim().url('Enter a full media link (https://…).').refine((u) => u.startsWith('https://'), 'Use an https:// link.'),
          caption: z.string().trim().max(1024).default(''),
        }),
      )
      .min(1, 'Add at least one image, video or document.')
      .max(10, 'A carousel can have at most 10 items.'),
  }),
  send_location: z.object({
    latitude: z.number({ message: 'Enter the latitude.' }).min(-90).max(90),
    longitude: z.number({ message: 'Enter the longitude.' }).min(-180).max(180),
    name: z.string().trim().max(100).optional(),
    address: z.string().trim().max(300).optional(),
  }),
  send_contacts: z.object({
    contacts: z
      .array(
        z.object({
          name: z.string().trim().min(1, 'Enter a name for every contact.').max(80),
          phone: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,20}$/, 'Enter a valid phone number for every contact.'),
          organization: z.string().trim().max(80).optional(),
        }),
      )
      .min(1, 'Add at least one contact.')
      .max(5, 'Send at most 5 contacts at once.'),
  }),
  send_catalog: z.object({
    text: z.string().trim().min(1, 'Write the message.').max(1024),
    footer: z.string().trim().max(60).optional(),
    // Product shown as the thumbnail; WhatsApp picks the first catalogue item when empty.
    thumbnailProductId: z.string().trim().max(100).optional(),
  }),
  rating: z.object({
    question: z.string().trim().min(1, 'Write the question.').max(1024),
    saveAs: varName.default('rating'),
    timeoutMinutes,
  }),
  ask_address: z.object({
    text: z.string().trim().min(1, 'Write the message.').max(1024),
    country: z.enum(['IN', 'SG']).default('IN'),
    timeoutMinutes,
  }),
  wait_reply: z.object({ amount: z.number().int().min(1).max(10_000), unit: z.enum(['minutes', 'hours', 'days']) }),
  time_check: z
    .object({
      // 0 = Sunday … 6 = Saturday, in the workspace timezone.
      days: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one day.').max(7),
      from: clock,
      to: clock,
    })
    .refine((c) => c.from !== c.to, { message: 'Start and end time must be different.', path: ['to'] }),
  add_tags: z.object({ tagIds: z.array(z.string().min(1)).min(1, 'Choose at least one tag.').max(10) }),
  set_stage: z.object({ stage: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Choose a stage.') }),
  set_field: z.object({
    field: z.string().regex(/^(name|email|custom\.[a-z0-9_]{1,40})$/, 'Choose a field.'),
    value: z.string().trim().min(1, 'Enter the value to save.').max(500),
  }),
  loop: z.object({
    // Comma or line separated; {{placeholders}} are filled in first.
    items: z.string().trim().min(1, 'Enter the items to loop over.').max(2000),
  }),
  book_appointment: z.object({
    service: z.string().trim().min(1, 'Name the service or appointment type.').max(120),
    durationMinutes: z.number().int().min(5).max(24 * 60).default(30),
    datePrompt: z.string().trim().min(1, 'Write the message that asks for a date.').max(1024),
    timePrompt: z.string().trim().min(1, 'Write the message that asks for a time.').max(1024),
    confirmation: z.string().trim().max(1024).default(''),
    daysAhead: z.number().int().min(1).max(10).default(7),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one working day.').max(7),
    slots: z.array(clock).min(1, 'Add at least one time slot.').max(10, 'Offer at most 10 time slots.'),
    timeoutMinutes,
  }),
  create_ticket: z.object({
    title: z.string().trim().min(1, 'Enter the ticket title.').max(200),
    description: z.string().trim().max(2000).default(''),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  }),
  resolve_chat: z.object({ message: z.string().trim().max(1024).optional() }),
  google_sheets: z.object({
    googleAccountId: z.string().min(1, 'Choose a Google account.'),
    sheetUrl: z.string().trim().regex(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+/, 'Paste the link of a Google Sheet.'),
    tab: z.string().trim().min(1, 'Enter the tab name.').max(100).default('Sheet1'),
    values: z.array(z.string().max(1000)).min(1, 'Add at least one column value.').max(26),
  }),
} satisfies Record<NodeType, z.ZodTypeAny>;

export type NodeConfig<T extends NodeType> = z.infer<(typeof nodeConfigSchemas)[T]>;

export function outputHandles(node: GraphNode): string[] {
  switch (node.type) {
    case 'send_buttons': {
      const buttons = (node.data.buttons as { id: string }[] | undefined) ?? [];
      return [...buttons.map((b) => `btn:${b.id}`), 'no_reply'];
    }
    case 'send_list': {
      const rows = (node.data.rows as { id: string }[] | undefined) ?? [];
      return [...rows.map((r) => `row:${r.id}`), 'no_reply'];
    }
    case 'ask':
    case 'rating':
    case 'ask_address':
      return ['answered', 'no_reply'];
    case 'wait_reply':
      return ['replied', 'no_reply'];
    case 'time_check':
      return ['true', 'false'];
    case 'loop':
      return ['item', 'done'];
    case 'book_appointment':
      return ['booked', 'no_reply'];
    case 'google_sheets':
      return ['success', 'failed'];
    case 'resolve_chat':
      return [];
    case 'send_form':
      return ['submitted', 'no_reply'];
    case 'condition':
      return ['true', 'false'];
    case 'ai_answer':
      return ['answered', 'handoff'];
    case 'http_request':
      return ['success', 'failed'];
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
