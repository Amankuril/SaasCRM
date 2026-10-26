import type { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { autoReply, getAgent } from '../ai/ai.service.js';
import { CampaignRecipient } from '../campaigns/campaign.model.js';
import { fieldValue, resolveVariables, type VariableSpec } from '../campaigns/campaign.service.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { startExecution } from '../flows/engine.js';
import { Flow, FlowVersion } from '../flows/flow.model.js';
import { sendForm } from '../forms/form.service.js';
import { Form } from '../forms/form.model.js';
import { queueOutboundMessage, type SendInput } from '../messages/message.service.js';
import { MessageTemplate } from '../templates/template.model.js';
import { checkSendValues, sendRequirements, templateExtrasSchema, type TemplateExtras } from '../templates/templateSend.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { AutoReply, AutoReplyFire, MESSAGE_SOURCES, TRIGGER_EVENTS, type AutoReplyDoc } from './autoReply.model.js';

const objectIdString = (what: string) => z.string().regex(/^[a-f0-9]{24}$/, `Choose a ${what}.`);
const variableSpec = z.object({ source: z.enum(['static', 'field']), value: z.string().max(500), fallback: z.string().max(500).default('') });
const interactiveText = { header: z.string().trim().max(60).optional(), footer: z.string().trim().max(60).optional() };
const message = (max: number) => z.string().trim().min(1, 'Write the message.').max(max);

/** What to do when a trigger fires; `config` per type. */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), config: z.object({ text: message(4096) }) }),
  z.object({
    type: z.literal('file'),
    config: z.object({
      mediaType: z.enum(['image', 'video', 'document', 'audio']),
      link: z.string().trim().url('Use a full https:// link.').max(2000).optional(),
      id: z.string().trim().max(100).optional(),
      filename: z.string().trim().max(240).optional(),
      caption: z.string().trim().max(1024).optional(),
    }).refine((c) => !!c.link || !!c.id, { message: 'Upload a file or add a link.', path: ['link'] }),
  }),
  z.object({
    type: z.literal('quick_reply'),
    config: z.object({
      text: message(1024),
      ...interactiveText,
      buttons: z
        .array(z.object({ title: z.string().trim().min(1, 'Name every button.').max(20, 'Button titles are at most 20 characters.') }))
        .min(1, 'Add at least one button.')
        .max(3, 'WhatsApp allows at most 3 quick reply buttons.'),
    }),
  }),
  z.object({
    type: z.literal('cta_url'),
    config: z.object({ text: message(1024), ...interactiveText, buttonText: z.string().trim().min(1, 'Name the button.').max(20), url: z.string().trim().url('Use a full https:// link.').max(2000) }),
  }),
  z.object({ type: z.literal('form'), config: z.object({ formId: objectIdString('form'), text: z.string().trim().max(1024).optional() }) }),
  z.object({ type: z.literal('chatbot'), config: z.object({ flowId: objectIdString('chatbot flow') }) }),
  z.object({ type: z.literal('ai_chatbot'), config: z.object({}).default({}) }),
  z.object({
    type: z.literal('location'),
    config: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().trim().max(100).optional(),
      address: z.string().trim().max(300).optional(),
    }),
  }),
  z.object({ type: z.literal('address'), config: z.object({ text: message(1024), country: z.enum(['IN', 'SG']).default('IN') }) }),
  z.object({
    type: z.literal('template'),
    config: z.object({
      templateId: objectIdString('template'),
      headerVariables: z.array(variableSpec).max(1).default([]),
      bodyVariables: z.array(variableSpec).max(50).default([]),
      buttonVariables: z.array(variableSpec).max(10).default([]),
      templateExtras: templateExtrasSchema.default({}),
    }),
  }),
  z.object({ type: z.literal('unsubscribe'), config: z.object({ text: message(1024) }) }),
]);
export type AutoReplyAction = z.infer<typeof actionSchema>;

export const autoReplyInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name this auto reply.').max(120),
    active: z.boolean().default(true),
    match: z.enum(['equals', 'contains', 'event']),
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    event: z.enum(TRIGGER_EVENTS).nullable().default(null),
    sources: z.array(z.enum(MESSAGE_SOURCES)).max(3).default([]),
    cooldownMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
    action: actionSchema,
  })
  .superRefine((t, ctx) => {
    if (t.match === 'event' && !t.event) ctx.addIssue({ code: 'custom', path: ['event'], message: 'Choose the event.' });
    if (t.match !== 'event' && !t.keywords.length) ctx.addIssue({ code: 'custom', path: ['keywords'], message: 'Add at least one keyword.' });
  });
export type AutoReplyInput = z.infer<typeof autoReplyInputSchema>;

const normalizeKeyword = (k: string) => k.trim().toLowerCase().replace(/\s+/g, ' ');

/** Checks the action's form / flow / template / AI agent exist and are usable. */
async function checkReferences(workspaceId: Types.ObjectId, action: AutoReplyAction) {
  const invalid = (message: string) => badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { action: [message] });
  switch (action.type) {
    case 'form': {
      const form = await Form.findOne({ _id: action.config.formId, workspaceId });
      if (!form) throw invalid('The selected form no longer exists.');
      if (form.status !== 'published') throw invalid(`Publish the form "${form.name}" first.`);
      break;
    }
    case 'chatbot': {
      const flow = await Flow.findOne({ _id: action.config.flowId, workspaceId });
      if (!flow) throw invalid('The selected chatbot flow no longer exists.');
      if (!flow.publishedVersionId) throw invalid(`Publish the flow "${flow.name}" first.`);
      break;
    }
    case 'ai_chatbot': {
      const agent = await getAgent(workspaceId);
      if (!agent?.enabled) throw invalid('Turn on the AI Agent first (Automation → AI Agent).');
      break;
    }
    case 'template': {
      const t = await MessageTemplate.findOne({ _id: action.config.templateId, workspaceId });
      if (!t) throw invalid('The selected template no longer exists.');
      if (t.status !== 'APPROVED') throw invalid(`Template "${t.name}" is not approved yet.`);
      const req = sendRequirements(t.components as never);
      const c = action.config;
      if (c.headerVariables.length !== req.header || c.bodyVariables.length !== req.body || c.buttonVariables.length !== req.buttons.length) {
        throw invalid('Map every template variable.');
      }
      const placeholder = (n: number) => Array<string>(n).fill('x');
      const issues = checkSendValues(req, { headerParams: placeholder(req.header), bodyParams: placeholder(req.body), buttonParams: placeholder(req.buttons.length), extras: c.templateExtras });
      const first = Object.values(issues)[0]?.[0];
      if (first) throw invalid(first);
      break;
    }
  }
}

/** The same keyword can only belong to one active trigger of a match type. */
async function checkKeywordClash(workspaceId: Types.ObjectId, input: AutoReplyInput, keywords: string[], excludeId?: Types.ObjectId) {
  if (!input.active || input.match === 'event' || !keywords.length) return;
  const clash = await AutoReply.findOne({ workspaceId, active: true, match: input.match, keywords: { $in: keywords }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  if (clash) {
    const word = clash.keywords.find((k) => keywords.includes(k));
    throw conflict('KEYWORD_IN_USE', `"${word}" is already used by the active auto reply "${clash.name}".`);
  }
}

export async function saveAutoReply(workspaceId: Types.ObjectId, userId: Types.ObjectId, input: AutoReplyInput, existing?: AutoReplyDoc): Promise<AutoReplyDoc> {
  const keywords = input.match === 'event' ? [] : [...new Set(input.keywords.map(normalizeKeyword))];
  await checkKeywordClash(workspaceId, input, keywords, existing?._id);
  await checkReferences(workspaceId, input.action);
  const fields = {
    name: input.name,
    active: input.active,
    match: input.match,
    keywords,
    event: input.match === 'event' ? input.event : null,
    sources: input.sources,
    cooldownMinutes: input.cooldownMinutes,
    action: input.action,
    updatedBy: userId,
  };
  if (existing) {
    existing.set(fields);
    return existing.save();
  }
  return AutoReply.create({ workspaceId, ...fields, createdBy: userId });
}

/** Turning a trigger back on re-checks keyword clashes. */
export async function setActive(rule: AutoReplyDoc, active: boolean, userId: Types.ObjectId) {
  if (active && !rule.active) await checkKeywordClash(rule.workspaceId, { ...(rule.toObject() as unknown as AutoReplyInput), active: true }, rule.keywords, rule._id);
  rule.set({ active, updatedBy: userId });
  return rule.save();
}

// ---- Matching ----

export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/** Where an inbound message came from: a click-to-WhatsApp ad, a reply to a recent broadcast, or neither. */
export async function messageSource(workspaceId: Types.ObjectId, contactId: Types.ObjectId, content: Record<string, unknown>, at = new Date()): Promise<MessageSource> {
  if (content.referral) return 'ad';
  const recentBroadcast = await CampaignRecipient.exists({
    workspaceId,
    contactId,
    status: { $in: ['submitted', 'sent', 'delivered', 'read'] },
    createdAt: { $gte: new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000) },
  });
  return recentBroadcast ? 'broadcast' : 'direct';
}

const sourceOk = (rule: { sources?: string[] }, source: MessageSource) => !rule.sources?.length || rule.sources.includes(source);

export interface KeywordMatch {
  rule: AutoReplyDoc;
  keyword: string;
}

/** Equals beats Contains; among Contains, the longest keyword wins (most specific). */
export async function findKeywordAutoReply(workspaceId: Types.ObjectId, text: string, source: MessageSource): Promise<KeywordMatch | null> {
  const lower = normalizeKeyword(text);
  if (!lower) return null;
  const rules = await AutoReply.find({ workspaceId, active: true, match: { $in: ['equals', 'contains'] } }).sort({ createdAt: 1 });
  const usable = rules.filter((r) => sourceOk(r, source));
  for (const r of usable.filter((r) => r.match === 'equals')) {
    if (r.keywords.includes(lower)) return { rule: r, keyword: lower };
  }
  let best: KeywordMatch | null = null;
  for (const r of usable.filter((r) => r.match === 'contains')) {
    for (const k of r.keywords) {
      if (lower.includes(k) && (!best || k.length > best.keyword.length)) best = { rule: r, keyword: k };
    }
  }
  return best;
}

/** "Customer's first message" beats "Any message". */
export async function findEventAutoReply(workspaceId: Types.ObjectId, firstMessage: boolean, source: MessageSource): Promise<AutoReplyDoc | null> {
  const rules = (await AutoReply.find({ workspaceId, active: true, match: 'event' }).sort({ createdAt: 1 })).filter((r) => sourceOk(r, source));
  return (firstMessage ? rules.find((r) => r.event === 'first_message') : undefined) ?? rules.find((r) => r.event === 'any_message') ?? null;
}

// ---- Firing ----

/** {{name}}, {{first_name}}, {{phone}}, {{email}} and {{custom.key}} from the contact. */
export function personalize(text: string, contact: Parameters<typeof fieldValue>[0]): string {
  return text.replace(/\{\{\s*(name|first_name|phone|email|custom\.[a-z0-9_]+)\s*\}\}/gi, (_m, key: string) => fieldValue(contact, key.toLowerCase()));
}

/**
 * Runs a matched trigger for one inbound message. Returns false when it did not
 * answer (cooldown, or the action declined), so other automations can.
 */
export async function fireAutoReply(
  workspace: WorkspaceDoc,
  contact: ContactDoc,
  rule: AutoReplyDoc,
  message: { id: string; text: string },
): Promise<boolean> {
  if (rule.cooldownMinutes > 0) {
    const recent = await AutoReplyFire.exists({
      workspaceId: workspace._id,
      autoReplyId: rule._id,
      contactId: contact._id,
      firedAt: { $gte: new Date(Date.now() - rule.cooldownMinutes * 60_000) },
    });
    if (recent) return false;
  }
  const handled = await runAction(workspace, contact, rule, message);
  if (!handled) return false;
  await AutoReplyFire.create({ workspaceId: workspace._id, autoReplyId: rule._id, contactId: contact._id, messageId: message.id });
  await AutoReply.updateOne({ _id: rule._id, workspaceId: workspace._id }, { $inc: { firedCount: 1 }, lastFiredAt: new Date() });
  return true;
}

async function runAction(workspace: WorkspaceDoc, contact: ContactDoc, rule: AutoReplyDoc, message: { id: string; text: string }): Promise<boolean> {
  const action = rule.action as unknown as AutoReplyAction;
  const key = `ar:${rule.id}:${message.id}`;
  const to = contact.phoneE164;
  const send = (input: SendInput) => queueOutboundMessage(workspace, null, input, key);
  const p = (text: string) => personalize(text, contact);

  switch (action.type) {
    case 'text':
      await send({ type: 'text', to, text: p(action.config.text) });
      return true;
    case 'file':
      await send({ type: 'media', to, ...action.config, ...(action.config.caption ? { caption: p(action.config.caption) } : {}) });
      return true;
    case 'quick_reply':
      await send({
        type: 'buttons',
        to,
        text: p(action.config.text),
        header: action.config.header,
        footer: action.config.footer,
        buttons: action.config.buttons.map((b, i) => ({ id: `ar_${rule.id}_${i + 1}`, title: b.title })),
      });
      return true;
    case 'cta_url':
      await send({ type: 'cta_url', to, text: p(action.config.text), header: action.config.header, footer: action.config.footer, buttonText: action.config.buttonText, url: action.config.url });
      return true;
    case 'location':
      await send({ type: 'location', to, ...action.config });
      return true;
    case 'address':
      await send({ type: 'address_request', to, text: p(action.config.text), country: action.config.country });
      return true;
    case 'unsubscribe': {
      await send({ type: 'text', to, text: p(action.config.text) });
      const before = await Contact.findOneAndUpdate({ _id: contact._id, workspaceId: workspace._id }, { consent: { status: 'opted_out', source: 'auto_reply', updatedAt: new Date() } });
      if (before?.consent?.status !== 'opted_out') {
        await emitEvent(workspace._id, 'contact.opted_out', async () => ({ contact: await contactPayload(workspace._id, contact._id), source: 'auto_reply' }));
      }
      return true;
    }
    case 'template': {
      const c = action.config;
      const header = resolveVariables(contact, c.headerVariables as VariableSpec[]);
      const body = resolveVariables(contact, c.bodyVariables as VariableSpec[]);
      const buttons = resolveVariables(contact, c.buttonVariables as VariableSpec[]);
      if (!header || !body || !buttons) {
        logger.warn({ autoReplyId: rule.id }, 'Auto reply template is missing a variable value for this contact');
        return false;
      }
      await send({ type: 'template', to, templateId: c.templateId, headerParams: header, bodyParams: body, buttonParams: buttons, extras: c.templateExtras as TemplateExtras });
      return true;
    }
    case 'form': {
      const form = await Form.findOne({ _id: action.config.formId, workspaceId: workspace._id });
      if (!form) return false;
      await sendForm(workspace, contact, form, { text: action.config.text ? p(action.config.text) : undefined, idempotencyKey: key });
      return true;
    }
    case 'chatbot': {
      const flow = await Flow.findOne({ _id: action.config.flowId, workspaceId: workspace._id, status: 'active' });
      const version = flow?.publishedVersionId ? await FlowVersion.findOne({ _id: flow.publishedVersionId, workspaceId: workspace._id }) : null;
      if (!version) return false;
      return !!(await startExecution(version, contact._id, { type: 'auto_reply', messageId: message.id, text: message.text.slice(0, 200) }));
    }
    case 'ai_chatbot': {
      return autoReply(workspace, contact, message);
    }
  }
}
