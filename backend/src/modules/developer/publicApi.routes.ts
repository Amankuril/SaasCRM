import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Types } from 'mongoose';
import { z } from 'zod';
import { buttonParamsSchema, templateExtrasSchema } from '../templates/templateSend.js';
import { isTest } from '../../config/env.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { emailSchema, objectId, parse } from '../../lib/validate.js';
import { publish } from '../../realtime/bus.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { Campaign } from '../campaigns/campaign.model.js';
import { campaignStats } from '../campaigns/campaign.service.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { assertStage, stageKeySchema } from '../audience/stage.service.js';
import { findOrCreateContact, normalizePhone } from '../contacts/contact.service.js';
import { Tag } from '../contacts/tag.model.js';
import { startExecution } from '../flows/engine.js';
import { Flow, FlowVersion } from '../flows/flow.model.js';
import { onTagsAdded } from '../flows/triggers.js';
import { Form, FormSubmission } from '../forms/form.model.js';
import { Conversation, CONVERSATION_STATUSES } from '../inbox/conversation.model.js';
import { Message } from '../messages/message.model.js';
import { queueOutboundMessage } from '../messages/message.service.js';
import { MessageTemplate, templateVariables } from '../templates/template.model.js';
import type { TemplateComponent } from '../whatsapp/provider/index.js';
import { requireApiKey, requireScope } from './apiKey.service.js';
import { API_VERSION } from './catalog.js';
import { WebhookDelivery, WebhookEndpoint } from './developer.model.js';
import { createEndpoint, createEndpointSchema, findEndpoint, rotateSecret, updateEndpoint, updateEndpointSchema } from './endpoints.js';
import { idempotent } from './idempotency.js';
import { apiContact, apiConversation, apiMessage } from './serializers.js';
import { emitEvent, sendTestEvent, toPublicDelivery, toPublicEndpoint } from './webhook.service.js';

/**
 * Public REST API, versioned under /api/v1 and authenticated with workspace API keys.
 * Responses: `{ data }` for one object, `{ data: [...], has_more, next_cursor }` for lists.
 * Errors: `{ error: { code, message, details?, request_id } }`.
 */
export const publicApiRouter = Router();

const keyLimiter = rateLimit({
  windowMs: 60_000,
  // Per plan (set by requireApiKey).
  limit: (_req, res) => Number(res.locals.apiRateLimit ?? 60),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => (req as Request).apiKey!.id as string,
  handler: (req, res) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests for this API key. Slow down and retry.', request_id: req.id } });
  },
});

publicApiRouter.use(requireApiKey, keyLimiter, (_req, res, next) => {
  res.setHeader('Zeta-Api-Version', API_VERSION);
  next();
});

// ---- helpers ----

const pageSchema = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
};

/** Newest first, cursor = id of the last item on the previous page. */
async function paginate<T extends { _id: Types.ObjectId }>(
  query: (filter: Record<string, unknown>, limit: number) => Promise<T[]>,
  filter: Record<string, unknown>,
  { limit, cursor }: { limit: number; cursor?: string },
) {
  const rows = await query(cursor ? { ...filter, _id: { $lt: objectId(cursor, 'Cursor') } } : filter, limit + 1);
  const page = rows.slice(0, limit);
  return { page, has_more: rows.length > limit, next_cursor: rows.length > limit ? page.at(-1)!._id.toString() : null };
}

async function tagNamesFor(workspaceId: Types.ObjectId, contacts: { tags?: Types.ObjectId[] }[]) {
  const ids = [...new Set(contacts.flatMap((c) => (c.tags ?? []).map(String)))];
  const tags = ids.length ? await Tag.find({ workspaceId, _id: { $in: ids } }).select('name').lean() : [];
  const byId = new Map(tags.map((t) => [t._id.toString(), t.name]));
  return (c: { tags?: Types.ObjectId[] }) => (c.tags ?? []).map((t) => byId.get(t.toString())).filter((n): n is string => !!n);
}

async function serializeContact(workspaceId: Types.ObjectId, contact: ContactDoc) {
  const names = await tagNamesFor(workspaceId, [contact]);
  return apiContact(contact, names(contact));
}

/** Integrations refer to tags by name; unknown names are created (case-insensitive match). */
async function tagIdsByName(workspaceId: Types.ObjectId, names: string[]): Promise<Types.ObjectId[]> {
  const out: Types.ObjectId[] = [];
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    let tag = await Tag.findOne({ workspaceId, name }).collation({ locale: 'en', strength: 2 });
    if (!tag) {
      try {
        tag = await Tag.create({ workspaceId, name });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        tag = await Tag.findOne({ workspaceId, name }).collation({ locale: 'en', strength: 2 });
      }
    }
    if (tag && !out.some((t) => t.equals(tag._id))) out.push(tag._id);
  }
  return out;
}

async function findContact(workspaceId: Types.ObjectId, id: unknown) {
  const contact = await Contact.findOne({ _id: objectId(id, 'Contact'), workspaceId });
  if (!contact) throw notFound('Contact not found.');
  return contact;
}

// ---- me ----

publicApiRouter.get('/me', (req, res) => {
  const ws = req.workspace!;
  res.json({
    data: {
      workspace: { id: ws.id as string, name: ws.name, timezone: ws.timezone, country: ws.country },
      api_key: { id: req.apiKey!.id as string, name: req.apiKey!.name, scopes: req.apiKey!.scopes, expires_at: req.apiKey!.expiresAt },
      api_version: API_VERSION,
    },
  });
});

// ---- contacts ----

const tagNameSchema = z.string().trim().min(1).max(40);
const customFieldsSchema = z
  .record(z.string().regex(/^[a-z0-9_]{1,40}$/, 'Custom field keys use lowercase letters, numbers and underscores.'), z.string().max(500).nullable())
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 custom fields.');
const contactFields = {
  name: z.string().trim().max(200).nullable(),
  email: emailSchema.nullable().or(z.literal('').transform(() => null)),
  lifecycle_stage: stageKeySchema,
  custom_fields: customFieldsSchema,
  external_id: z.string().trim().max(200).nullable(),
  opt_in_status: z.enum(['opted_in', 'opted_out']),
};
const upsertContactSchema = z.object({ phone: z.string().trim().min(5).max(30), tags: z.array(tagNameSchema).max(50).optional(), ...contactFields }).partial().required({ phone: true });
const updateContactSchema = z.object(contactFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');
const contactListSchema = z.object({ ...pageSchema, phone: z.string().optional(), tag: z.string().optional(), stage: stageKeySchema.optional() });

/** Applies API fields to a contact. Custom fields merge (null removes a key); nothing else is touched. */
function applyContactFields(contact: ContactDoc, input: Partial<z.infer<z.ZodObject<typeof contactFields>>>) {
  if (input.name !== undefined) contact.name = input.name || null;
  if (input.email !== undefined) contact.email = input.email;
  if (input.lifecycle_stage) contact.lifecycleStage = input.lifecycle_stage;
  if (input.external_id !== undefined) contact.externalId = input.external_id || null;
  if (input.custom_fields) {
    const merged = { ...((contact.customFields ?? {}) as Record<string, string>) };
    for (const [k, v] of Object.entries(input.custom_fields)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    contact.customFields = merged;
  }
  if (input.opt_in_status && input.opt_in_status !== contact.consent?.status) {
    contact.consent = { status: input.opt_in_status, source: 'api', updatedAt: new Date() };
  }
}

publicApiRouter.get('/contacts', requireScope('contacts:read'), async (req, res) => {
  const { phone, tag, stage, ...page } = parse(contactListSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter: Record<string, unknown> = { workspaceId };
  if (phone) {
    const e164 = normalizePhone(phone, req.workspace!.country);
    if (!e164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
    filter.phoneE164 = e164;
  }
  if (stage) filter.lifecycleStage = stage;
  if (tag) {
    const found = await Tag.findOne({ workspaceId, name: tag }).collation({ locale: 'en', strength: 2 }).lean();
    filter.tags = found?._id ?? new Types.ObjectId();
  }
  const { page: rows, ...rest } = await paginate((f, limit) => Contact.find(f).sort({ _id: -1 }).limit(limit).lean(), filter, page);
  const names = await tagNamesFor(workspaceId, rows);
  res.json({ data: rows.map((c) => apiContact(c, names(c))), ...rest });
});

/** Create-or-update by phone number. 201 when created, 200 when an existing contact was updated. */
publicApiRouter.post('/contacts', requireScope('contacts:write'), idempotent, async (req, res) => {
  const input = parse(upsertContactSchema, req.body);
  const workspaceId = req.workspace!._id;
  const phoneE164 = normalizePhone(input.phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });

  let contact = await Contact.findOne({ workspaceId, phoneE164 });
  const created = !contact;
  if (created) await assertWithinLimit(workspaceId, 'contacts', await Contact.countDocuments({ workspaceId }));
  contact ??= new Contact({ workspaceId, phoneE164, source: 'api' });
  if (input.lifecycle_stage) await assertStage(req.workspace!._id, input.lifecycle_stage, 'lifecycle_stage');
  applyContactFields(contact, input);
  let added: Types.ObjectId[] = [];
  if (input.tags) {
    const ids = await tagIdsByName(workspaceId, input.tags);
    added = ids.filter((t) => !contact.tags.some((c) => c.equals(t)));
    contact.tags.push(...added);
  }
  try {
    await contact.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('CONTACT_CONFLICT', 'This contact was created by another request at the same time. Retry.');
    throw err;
  }

  const data = await serializeContact(workspaceId, contact);
  if (created) await emitEvent(workspaceId, 'contact.created', { contact: data });
  if (added.length) await onTagsAdded(workspaceId, contact._id, added);
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(created ? 201 : 200).json({ data, created });
});

publicApiRouter.get('/contacts/:contactId', requireScope('contacts:read'), async (req, res) => {
  const contact = await findContact(req.workspace!._id, req.params.contactId);
  res.json({ data: await serializeContact(req.workspace!._id, contact) });
});

publicApiRouter.patch('/contacts/:contactId', requireScope('contacts:write'), idempotent, async (req, res) => {
  const input = parse(updateContactSchema, req.body);
  const contact = await findContact(req.workspace!._id, req.params.contactId);
  if (input.lifecycle_stage) await assertStage(req.workspace!._id, input.lifecycle_stage, 'lifecycle_stage');
  applyContactFields(contact, input);
  await contact.save();
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ data: await serializeContact(req.workspace!._id, contact) });
});

const tagChangeSchema = z
  .object({ add: z.array(tagNameSchema).max(50).default([]), remove: z.array(tagNameSchema).max(50).default([]) })
  .refine((v) => v.add.length + v.remove.length > 0, 'Add or remove at least one tag.');

publicApiRouter.post('/contacts/:contactId/tags', requireScope('contacts:write'), idempotent, async (req, res) => {
  const input = parse(tagChangeSchema, req.body);
  const workspaceId = req.workspace!._id;
  const contact = await findContact(workspaceId, req.params.contactId);
  const toAdd = await tagIdsByName(workspaceId, input.add);
  const removeLower = new Set(input.remove.map((n) => n.toLowerCase()));
  const toRemove = input.remove.length ? (await Tag.find({ workspaceId, _id: { $in: contact.tags } }).select('name').lean()).filter((t) => removeLower.has(t.name.toLowerCase())) : [];

  const added = toAdd.filter((t) => !contact.tags.some((c) => c.equals(t)));
  contact.tags = [...contact.tags.filter((t) => !toRemove.some((r) => r._id.equals(t))), ...added] as typeof contact.tags;
  await contact.save();
  if (added.length) await onTagsAdded(workspaceId, contact._id, added);
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ data: await serializeContact(workspaceId, contact) });
});

// ---- messages ----

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), to: z.string().trim().min(5).max(30), text: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal('template'),
    to: z.string().trim().min(5).max(30),
    template: z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().max(15).optional() }),
    header_params: z.array(z.string().max(1024)).max(1).default([]),
    body_params: z.array(z.string().max(1024)).max(50).default([]),
    // URL suffixes / coupon codes, in button order.
    button_params: buttonParamsSchema,
    header_media: z.object({ link: z.string().url().max(2000).optional(), id: z.string().max(100).optional(), filename: z.string().max(240).optional() }).optional(),
    header_location: z.object({ latitude: z.number(), longitude: z.number(), name: z.string().max(100).optional(), address: z.string().max(300).optional() }).optional(),
    offer_expires_at: z.string().optional(),
    products: z.object({ thumbnail: z.string(), items: z.array(z.string()).default([]) }).optional(),
    otp_code: z.string().optional(),
    cards: z.array(z.object({ media: z.object({ link: z.string().optional(), id: z.string().optional() }), body_params: z.array(z.string()).default([]), button_params: z.array(z.string()).default([]) })).optional(),
  }),
]);

/** Templates are addressed by name (+ language when a name has several); approved first. */
async function findTemplate(workspaceId: Types.ObjectId, name: string, language?: string) {
  const candidates = await MessageTemplate.find({ workspaceId, name, ...(language ? { language } : {}) });
  if (!candidates.length) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { template: [`No template named "${name}"${language ? ` in ${language}` : ''}.`] });
  const approved = candidates.filter((t) => t.status === 'APPROVED');
  if (approved.length > 1) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { template: ['Several languages exist for this template. Pass template.language.'] });
  return approved[0] ?? candidates[0]!;
}

publicApiRouter.post('/messages', requireScope('messages:send'), async (req, res) => {
  const input = parse(sendSchema, req.body);
  const key = req.get('idempotency-key')?.trim() || null;
  if (key && key.length > 200) throw badRequest('VALIDATION_ERROR', 'Idempotency-Key is too long.');
  const workspaceId = req.workspace!._id;
  // Namespaced so API keys can't collide with dashboard/flow keys.
  const scopedKey = key ? `api:${req.apiKey!.id}:${key}` : null;

  const send =
    input.type === 'text'
      ? input
      : {
          type: 'template' as const,
          to: input.to,
          templateId: (await findTemplate(workspaceId, input.template.name, input.template.language)).id as string,
          headerParams: input.header_params,
          bodyParams: input.body_params,
          buttonParams: input.button_params,
          // Re-checked against the dashboard schema so both entry points accept the same values.
          extras: parse(templateExtrasSchema, {
            headerMedia: input.header_media,
            headerLocation: input.header_location,
            offerExpiresAt: input.offer_expires_at,
            products: input.products,
            otpCode: input.otp_code,
            cards: input.cards?.map((c) => ({ media: c.media, bodyParams: c.body_params, buttonParams: c.button_params })),
          }),
        };
  const { message, duplicate } = await queueOutboundMessage(req.workspace!, null, send, scopedKey);
  res.status(duplicate ? 200 : 202).json({ data: apiMessage(message) });
});

publicApiRouter.get('/messages', requireScope('messages:read'), async (req, res) => {
  const { contact_id, ...page } = parse(z.object({ ...pageSchema, contact_id: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = { workspaceId: req.workspace!._id };
  if (contact_id) filter.contactId = objectId(contact_id, 'Contact');
  const { page: rows, ...rest } = await paginate((f, limit) => Message.find(f).sort({ _id: -1 }).limit(limit).lean(), filter, page);
  res.json({ data: rows.map(apiMessage), ...rest });
});

publicApiRouter.get('/messages/:messageId', requireScope('messages:read'), async (req, res) => {
  const message = await Message.findOne({ _id: objectId(req.params.messageId, 'Message'), workspaceId: req.workspace!._id }).lean();
  if (!message) throw notFound('Message not found.');
  res.json({ data: apiMessage(message) });
});

// ---- templates ----

publicApiRouter.get('/templates', requireScope('templates:read'), async (req, res) => {
  const { status } = parse(z.object({ status: z.string().toUpperCase().optional() }), req.query);
  const templates = await MessageTemplate.find({ workspaceId: req.workspace!._id, ...(status ? { status } : {}) }).sort({ name: 1 }).lean();
  res.json({
    data: templates.map((t) => {
      const vars = templateVariables(t.components as TemplateComponent[]);
      return { id: t._id.toString(), name: t.name, language: t.language, category: t.category, status: t.status, header_params: vars.header, body_params: vars.body, components: t.components };
    }),
    has_more: false,
    next_cursor: null,
  });
});

// ---- conversations ----

publicApiRouter.get('/conversations', requireScope('conversations:read'), async (req, res) => {
  const { status, contact_id, ...page } = parse(z.object({ ...pageSchema, status: z.enum(CONVERSATION_STATUSES).optional(), contact_id: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = { workspaceId: req.workspace!._id };
  if (status) filter.status = status;
  if (contact_id) filter.contactId = objectId(contact_id, 'Contact');
  const { page: rows, ...rest } = await paginate((f, limit) => Conversation.find(f).sort({ _id: -1 }).limit(limit).lean(), filter, page);
  res.json({ data: rows.map(apiConversation), ...rest });
});

// ---- campaigns ----

function apiCampaign(c: { _id: Types.ObjectId; name: string; status: string; templateSnapshot?: unknown; scheduledAt?: Date | null; launchedAt?: Date | null; completedAt?: Date | null; createdAt?: Date }, stats?: Record<string, number>) {
  const s = stats ?? {};
  return {
    id: c._id.toString(),
    name: c.name,
    status: c.status,
    template_name: (c.templateSnapshot as { name?: string } | null)?.name ?? null,
    scheduled_at: c.scheduledAt ?? null,
    launched_at: c.launchedAt ?? null,
    completed_at: c.completedAt ?? null,
    created_at: c.createdAt ?? null,
    report: {
      total: s.total ?? 0,
      sent: (s.sent ?? 0) + (s.delivered ?? 0) + (s.read ?? 0),
      delivered: (s.delivered ?? 0) + (s.read ?? 0),
      read: s.read ?? 0,
      replied: s.replied ?? 0,
      failed: s.failed ?? 0,
      skipped: s.skipped ?? 0,
      pending: (s.pending ?? 0) + (s.queued ?? 0) + (s.submitted ?? 0),
    },
  };
}

publicApiRouter.get('/campaigns', requireScope('campaigns:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const page = parse(z.object(pageSchema), req.query);
  const { page: rows, ...rest } = await paginate((f, limit) => Campaign.find(f).sort({ _id: -1 }).limit(limit).lean(), { workspaceId }, page);
  const stats = await campaignStats(workspaceId, rows.map((c) => c._id));
  res.json({ data: rows.map((c) => apiCampaign(c, stats.get(c._id.toString()))), ...rest });
});

publicApiRouter.get('/campaigns/:campaignId', requireScope('campaigns:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const campaign = await Campaign.findOne({ _id: objectId(req.params.campaignId, 'Campaign'), workspaceId }).lean();
  if (!campaign) throw notFound('Campaign not found.');
  const stats = await campaignStats(workspaceId, [campaign._id]);
  res.json({ data: apiCampaign(campaign, stats.get(campaign._id.toString())) });
});

// ---- flows ----

publicApiRouter.get('/flows', requireScope('flows:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flows = await Flow.find({ workspaceId }).sort({ createdAt: -1 }).lean();
  const versions = await FlowVersion.find({ workspaceId, _id: { $in: flows.map((f) => f.publishedVersionId).filter(Boolean) } }).select('trigger').lean();
  const triggerOf = new Map(versions.map((v) => [v._id.toString(), v.trigger?.event ?? null]));
  res.json({
    data: flows.map((f) => ({
      id: f._id.toString(),
      name: f.name,
      status: f.status,
      trigger: f.publishedVersionId ? triggerOf.get(f.publishedVersionId.toString()) ?? null : null,
      published_version: f.publishedVersion,
      // Only flows with the "Started by API" trigger can be run through POST /flows/:id/runs.
      api_runnable: f.status === 'active' && !!f.publishedVersionId && triggerOf.get(f.publishedVersionId.toString()) === 'api',
    })),
    has_more: false,
    next_cursor: null,
  });
});

const runSchema = z.object({
  phone: z.string().trim().min(5).max(30),
  // Available in the flow as {{vars.<key>}}.
  variables: z
    .record(z.string().regex(/^[a-z0-9_]{1,40}$/, 'Variable names use lowercase letters, numbers and underscores.'), z.union([z.string().max(1000), z.number(), z.boolean()]))
    .refine((v) => Object.keys(v).length <= 30, 'At most 30 variables.')
    .default({}),
});

publicApiRouter.post('/flows/:flowId/runs', requireScope('flows:run'), idempotent, async (req, res) => {
  const input = parse(runSchema, req.body);
  const workspace = req.workspace!;
  const flow = await Flow.findOne({ _id: objectId(req.params.flowId, 'Flow'), workspaceId: workspace._id });
  if (!flow) throw notFound('Flow not found.');
  const version = flow.publishedVersionId ? await FlowVersion.findOne({ _id: flow.publishedVersionId, workspaceId: workspace._id }) : null;
  if (flow.status !== 'active' || !version) throw conflict('FLOW_NOT_ACTIVE', 'This flow is not live. Publish and activate it first.');
  if (version.trigger?.event !== 'api') throw conflict('FLOW_NOT_API', 'Only flows with the "Started by API" trigger can be run through the API.');

  const phoneE164 = normalizePhone(input.phone, workspace.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  const existed = await Contact.exists({ workspaceId: workspace._id, phoneE164 });
  if (!existed) await assertWithinLimit(workspace._id, 'contacts', await Contact.countDocuments({ workspaceId: workspace._id }));
  const contact = await findOrCreateContact(workspace._id, phoneE164, 'api');
  if (!existed) await emitEvent(workspace._id, 'contact.created', { contact: await serializeContact(workspace._id, contact) });
  if (contact.consent?.status === 'opted_out') throw new AppError(422, 'CONTACT_OPTED_OUT', 'This contact has opted out of WhatsApp messages.');

  const vars = Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [k, String(v)]));
  const exec = await startExecution(version, contact._id, { type: 'api', text: `api key ${req.apiKey!.name}`, vars });
  if (!exec) throw conflict('FLOW_BUSY', 'This contact is already in this flow.');
  res.status(202).json({ data: { id: exec.id as string, flow_id: flow.id as string, contact_id: contact.id as string, status: exec.status } });
});

// ---- forms ----

publicApiRouter.get('/forms', requireScope('forms:read'), async (req, res) => {
  const forms = await Form.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 }).lean();
  res.json({
    data: forms.map((f) => ({ id: f._id.toString(), name: f.name, status: f.status, version: f.version, fields: f.publishedFields ?? [], published_at: f.publishedAt ?? null })),
    has_more: false,
    next_cursor: null,
  });
});

publicApiRouter.get('/forms/:formId/submissions', requireScope('forms:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const form = await Form.findOne({ _id: objectId(req.params.formId, 'Form'), workspaceId }).lean();
  if (!form) throw notFound('Form not found.');
  const page = parse(z.object(pageSchema), req.query);
  const { page: rows, ...rest } = await paginate((f, limit) => FormSubmission.find(f).sort({ _id: -1 }).limit(limit).lean(), { workspaceId, formId: form._id }, page);
  res.json({
    data: rows.map((s) => ({ id: s._id.toString(), form_id: form._id.toString(), form_version: s.formVersion, contact_id: s.contactId?.toString() ?? null, data: s.data, valid: s.valid, submitted_at: s.submittedAt })),
    ...rest,
  });
});

// ---- webhooks ----

publicApiRouter.get('/webhooks', requireScope('webhooks:manage'), async (req, res) => {
  const endpoints = await WebhookEndpoint.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 });
  res.json({ data: endpoints.map(toPublicEndpoint), has_more: false, next_cursor: null });
});

publicApiRouter.post('/webhooks', requireScope('webhooks:manage'), idempotent, async (req, res) => {
  const { endpoint, secret } = await createEndpoint(req.workspace!._id, parse(createEndpointSchema, req.body), null);
  // The signing secret is returned exactly once.
  res.status(201).json({ data: { ...toPublicEndpoint(endpoint), secret } });
});

publicApiRouter.patch('/webhooks/:webhookId', requireScope('webhooks:manage'), async (req, res) => {
  const endpoint = await updateEndpoint(await findEndpoint(req.workspace!._id, req.params.webhookId), parse(updateEndpointSchema, req.body));
  res.json({ data: toPublicEndpoint(endpoint) });
});

publicApiRouter.delete('/webhooks/:webhookId', requireScope('webhooks:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const endpoint = await findEndpoint(workspaceId, req.params.webhookId);
  await Promise.all([WebhookDelivery.deleteMany({ workspaceId, endpointId: endpoint._id }), WebhookEndpoint.deleteOne({ _id: endpoint._id, workspaceId })]);
  res.status(204).end();
});

publicApiRouter.post('/webhooks/:webhookId/rotate-secret', requireScope('webhooks:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { endpoint, secret } = await rotateSecret(workspaceId, (await findEndpoint(workspaceId, req.params.webhookId))._id);
  res.json({ data: { ...toPublicEndpoint(endpoint), secret } });
});

publicApiRouter.post('/webhooks/:webhookId/test', requireScope('webhooks:manage'), async (req, res) => {
  const delivery = await sendTestEvent(await findEndpoint(req.workspace!._id, req.params.webhookId));
  res.json({ data: toPublicDelivery(delivery) });
});
