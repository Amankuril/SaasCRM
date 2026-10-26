import type { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict } from '../../lib/errors.js';
import type { UserDoc } from '../auth/user.model.js';
import { Campaign } from '../campaigns/campaign.model.js';
import { Flow } from '../flows/flow.model.js';
import { FORM_SCREEN_ID } from '../forms/flowJson.js';
import { Form } from '../forms/form.model.js';
import { credentialsOf, providerToAppError } from '../whatsapp/connection.service.js';
import type { ConnectionDoc } from '../whatsapp/connection.model.js';
import { whatsappProvider, type LibraryTemplate, type TemplateButton, type TemplateComponent } from '../whatsapp/provider/index.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { MessageTemplate, TEMPLATE_TYPES, countVariables, type TemplateDoc, type TemplateType } from './template.model.js';

/** Pulls every template from the provider and mirrors it locally (provider is the source of truth). */
export async function syncTemplates(workspace: WorkspaceDoc, conn: ConnectionDoc): Promise<{ synced: number; removed: number }> {
  let remote;
  try {
    remote = await whatsappProvider().listTemplates(credentialsOf(conn));
  } catch (err) {
    throw providerToAppError(err, 'Could not fetch templates from WhatsApp');
  }

  const now = new Date();
  for (const t of remote) {
    await MessageTemplate.updateOne(
      { workspaceId: workspace._id, name: t.name, language: t.language },
      {
        $set: {
          providerTemplateId: t.providerTemplateId,
          category: t.category,
          status: t.status,
          rejectedReason: t.rejectedReason,
          components: t.components,
          draft: null,
          syncedAt: now,
        },
        $setOnInsert: { workspaceId: workspace._id },
      },
      { upsert: true },
    );
  }
  // Templates deleted on the provider side disappear locally too.
  const removed = await MessageTemplate.deleteMany({ workspaceId: workspace._id, syncedAt: { $ne: now }, providerTemplateId: { $ne: null } });
  return { synced: remote.length, removed: removed.deletedCount };
}

const variableText = (max: number) => z.string().trim().min(1, 'Fill in every required field in this section.').max(max, `Keep it under ${max + 1} characters.`);
const templateName = z
  .string()
  .trim()
  .min(1, 'Name the template.')
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores only.')
  .max(512);
const languageCode = z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Use a language code like en, en_US or hi.');

const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: variableText(25) }),
  z.object({
    type: z.literal('URL'),
    text: variableText(25),
    url: z.string().url().max(2000),
    // Value for a trailing {{1}} in the URL, e.g. an order id.
    example: z.string().trim().max(2000).optional(),
  }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: variableText(25), phone: z.string().regex(/^\+\d{8,15}$/, 'Use +countrycode format.') }),
  z.object({ type: z.literal('COPY_CODE'), example: variableText(15) }),
  z.object({ type: z.literal('FLOW'), text: variableText(25), formId: z.string().regex(/^[a-f0-9]{24}$/, 'Choose a published form.') }),
]);
type ButtonInput = z.infer<typeof buttonSchema>;

const MEDIA_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;

const bodySchema = z.object({ text: variableText(1024), examples: z.array(z.string().trim().min(1).max(200)).default([]) });

export const templateInputSchema = z
  .object({
    type: z.enum(TEMPLATE_TYPES).default('CUSTOM'),
    name: templateName,
    language: languageCode,
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
    header: z
      .object({
        format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION']).default('TEXT'),
        text: z.string().trim().max(60).optional(),
        example: z.string().trim().max(60).optional(),
        // Sample media handle from POST /templates/media.
        handle: z.string().max(4000).optional(),
      })
      .optional(),
    body: bodySchema.optional(),
    footer: z.object({ text: variableText(60) }).optional(),
    buttons: z.array(buttonSchema).max(10).default([]),
    otp: z
      .object({
        otpType: z.enum(['COPY_CODE', 'ONE_TAP']).default('COPY_CODE'),
        buttonText: variableText(25).default('Copy code'),
        autofillText: z.string().trim().max(25).optional(),
        securityRecommendation: z.boolean().default(true),
        expiryMinutes: z.number().int().min(1).max(90).optional(),
        packageName: z.string().trim().max(224).optional(),
        signatureHash: z.string().trim().max(11).optional(),
      })
      .optional(),
    offer: z.object({ text: variableText(16), hasExpiration: z.boolean().default(true) }).optional(),
    cards: z
      .array(
        z.object({
          header: z.object({ format: z.enum(['IMAGE', 'VIDEO']), handle: z.string().min(1, 'Upload an image or video for every card.').max(4000) }),
          body: z.object({ text: variableText(160), examples: z.array(z.string().trim().min(1).max(200)).default([]) }),
          buttons: z.array(buttonSchema).min(1, 'Each card needs at least one button.').max(2),
        }),
      )
      .max(10)
      .optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const auth = t.type === 'AUTHENTICATION';

    if (auth !== (t.category === 'AUTHENTICATION')) issue('category', auth ? 'OTP templates use the Authentication category.' : 'Only OTP templates can use the Authentication category.');
    if (['LIMITED_TIME_OFFER', 'CAROUSEL', 'CATALOG', 'MULTI_PRODUCT'].includes(t.type) && t.category !== 'MARKETING') issue('category', 'This template type must use the Marketing category.');

    if (auth) {
      if (!t.otp) issue('otp', 'Choose how the code is delivered.');
      if (t.otp?.otpType === 'ONE_TAP' && (!t.otp.packageName || !t.otp.signatureHash)) issue('otp', 'One-tap autofill needs your Android package name and app signature hash.');
      if (t.header || t.footer || t.buttons.length) issue('otp', 'OTP templates have a fixed layout: no custom header, footer or buttons.');
      return;
    }

    if (!t.body) return issue('body', 'Write the message body.');
    checkBody(t.body, 'body', issue);

    if (t.header) checkHeader(t.header, issue);

    const counts = (types: string[]) => t.buttons.filter((b) => types.includes(b.type)).length;
    switch (t.type) {
      case 'CUSTOM':
        if (counts(['FLOW'])) issue('buttons', 'Use the Flows template type for form buttons.');
        break;
      case 'FLOW':
        if (counts(['FLOW']) !== 1 || t.buttons.length !== 1) issue('buttons', 'Flow templates have exactly one form button.');
        break;
      case 'LIMITED_TIME_OFFER':
        if (!t.offer) issue('offer', 'Write the offer headline.');
        if (t.footer) issue('footer', 'Limited-time offers cannot have a footer.');
        if (t.header && !['IMAGE', 'VIDEO'].includes(t.header.format)) issue('header', 'Limited-time offers can only have an image or video header.');
        if (t.body.text.length > 600) issue('body', 'Limited-time offer bodies are at most 600 characters.');
        if (!counts(['URL'])) issue('buttons', 'Add a website button for customers to redeem the offer.');
        if (t.buttons.some((b) => !['URL', 'COPY_CODE'].includes(b.type))) issue('buttons', 'Limited-time offers only support Copy code and Website buttons.');
        break;
      case 'CAROUSEL': {
        if (t.header || t.footer || t.buttons.length) issue('cards', 'Carousels have no header, footer or buttons outside the cards.');
        const cards = t.cards ?? [];
        if (cards.length < 2) return issue('cards', 'A carousel needs 2 to 10 cards.');
        const shape = (c: (typeof cards)[number]) => `${c.header.format}:${c.buttons.map((b) => b.type).join(',')}`;
        if (cards.some((c) => shape(c) !== shape(cards[0]!))) issue('cards', 'Every card must use the same media type and the same buttons in the same order.');
        cards.forEach((c, i) => checkBody(c.body, 'cards', (path, message) => issue(path, `Card ${i + 1}: ${message}`)));
        break;
      }
      case 'CATALOG':
      case 'MULTI_PRODUCT':
      case 'CALL_PERMISSION':
        if (t.buttons.length) issue('buttons', 'This template type adds its own button.');
        if (t.header && t.header.format !== 'TEXT') issue('header', 'This template type only supports a text header.');
        if (t.type === 'MULTI_PRODUCT' && !t.header?.text) issue('header', 'Multi-product templates need a text header.');
        break;
    }

    if (counts(['URL']) > 2) issue('buttons', 'At most 2 website buttons.');
    if (counts(['PHONE_NUMBER']) > 1) issue('buttons', 'At most 1 call button.');
    if (counts(['COPY_CODE']) > 1) issue('buttons', 'At most 1 copy code button.');
    for (const b of [...t.buttons, ...(t.cards ?? []).flatMap((c) => c.buttons)]) {
      if (b.type === 'URL' && b.url.includes('{{')) {
        if (!/^[^{}]*\{\{1\}\}$/.test(b.url)) issue('buttons', 'A website button can only have one variable, {{1}}, at the end of the URL.');
        else if (!b.example) issue('buttons', 'Give an example value for the website button variable.');
      }
    }
  });

type Issue = (path: string, message: string) => void;

function checkBody(body: { text: string; examples: string[] }, path: string, issue: Issue) {
  if (!isSequential(placeholders(body.text))) issue(path, 'Variables must be numbered {{1}}, {{2}}, ... in order.');
  if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(body.text)) issue(path, 'WhatsApp does not allow the body to start or end with a variable.');
  if (body.examples.length !== countVariables(body.text)) issue(path, 'Give one example value for each body variable.');
}

function checkHeader(header: NonNullable<TemplateInput['header']>, issue: Issue) {
  if (header.format === 'TEXT') {
    if (!header.text) return issue('header', 'Write the header text, or remove the header.');
    const headerVars = placeholders(header.text);
    if (headerVars.length > 1 || (headerVars.length === 1 && headerVars[0] !== 1)) issue('header', 'The header can have at most one variable, {{1}}.');
    if (headerVars.length === 1 && !header.example) issue('header', 'Give an example value for the header variable.');
  } else if ((MEDIA_FORMATS as readonly string[]).includes(header.format) && !header.handle) {
    issue('header', `Upload a sample ${header.format.toLowerCase()} for the header.`);
  }
}

export type TemplateInput = z.infer<typeof templateInputSchema>;

/** Drafts are saved half-finished, so only the name and language are checked. */
export const draftInputSchema = z
  .object({ type: z.enum(TEMPLATE_TYPES).default('CUSTOM'), name: templateName, language: languageCode, category: z.string().max(20).default('MARKETING') })
  .passthrough();

type FlowRefs = Map<string, { flowId: string; screen: string }>;

/** Form buttons reference our forms; Meta needs the published flow id. */
async function resolveForms(workspaceId: Types.ObjectId, input: TemplateInput): Promise<FlowRefs> {
  const ids = [...input.buttons, ...(input.cards ?? []).flatMap((c) => c.buttons)].flatMap((b) => (b.type === 'FLOW' ? [b.formId] : []));
  const refs: FlowRefs = new Map();
  if (!ids.length) return refs;
  const forms = await Form.find({ workspaceId, _id: { $in: ids } });
  for (const id of ids) {
    const form = forms.find((f) => f.id === id);
    if (!form || form.status !== 'published' || !form.providerFlowId) {
      throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { buttons: ['The selected form is not published to WhatsApp yet.'] });
    }
    refs.set(id, { flowId: form.providerFlowId, screen: FORM_SCREEN_ID });
  }
  return refs;
}

function toButton(b: ButtonInput, flows: FlowRefs): TemplateButton {
  switch (b.type) {
    case 'URL':
      return { type: 'URL', text: b.text, url: b.url, ...(b.url.includes('{{1}}') && b.example ? { example: [b.example] } : {}) };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', example: b.example };
    case 'FLOW': {
      const ref = flows.get(b.formId)!;
      return { type: 'FLOW', text: b.text, flow_id: ref.flowId, navigate_screen: ref.screen, flow_action: 'navigate' };
    }
    default:
      return { type: 'QUICK_REPLY', text: b.text };
  }
}

function bodyComponent(body: { text: string; examples: string[] }): TemplateComponent {
  return { type: 'BODY', text: body.text, ...(body.examples.length ? { example: { body_text: [body.examples] } } : {}) };
}

export function toComponents(input: TemplateInput, flows: FlowRefs = new Map()): TemplateComponent[] {
  if (input.type === 'AUTHENTICATION') {
    const otp = input.otp!;
    return [
      { type: 'BODY', add_security_recommendation: otp.securityRecommendation },
      ...(otp.expiryMinutes ? [{ type: 'FOOTER' as const, code_expiration_minutes: otp.expiryMinutes }] : []),
      {
        type: 'BUTTONS',
        buttons: [
          otp.otpType === 'ONE_TAP'
            ? {
                type: 'OTP',
                otp_type: 'ONE_TAP',
                text: otp.buttonText,
                ...(otp.autofillText ? { autofill_text: otp.autofillText } : {}),
                supported_apps: [{ package_name: otp.packageName!, signature_hash: otp.signatureHash! }],
              }
            : { type: 'OTP', otp_type: 'COPY_CODE', text: otp.buttonText },
        ],
      },
    ];
  }

  const components: TemplateComponent[] = [];
  const header = input.header;
  if (header?.format === 'TEXT' && header.text) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: header.text,
      ...(countVariables(header.text) ? { example: { header_text: [header.example] } } : {}),
    });
  } else if (header?.format === 'LOCATION') {
    components.push({ type: 'HEADER', format: 'LOCATION' });
  } else if (header && header.handle) {
    components.push({ type: 'HEADER', format: header.format, example: { header_handle: [header.handle] } });
  }

  if (input.type === 'LIMITED_TIME_OFFER' && input.offer) {
    components.push({ type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: input.offer.text, has_expiration: input.offer.hasExpiration } });
  }
  components.push(bodyComponent(input.body!));
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer.text });

  if (input.type === 'CAROUSEL') {
    components.push({
      type: 'CAROUSEL',
      cards: (input.cards ?? []).map((c) => ({
        components: [
          { type: 'HEADER', format: c.header.format, example: { header_handle: [c.header.handle] } },
          bodyComponent(c.body),
          { type: 'BUTTONS', buttons: c.buttons.map((b) => toButton(b, flows)) },
        ],
      })),
    });
  }
  if (input.type === 'CALL_PERMISSION') components.push({ type: 'CALL_PERMISSION_REQUEST' });

  const buttons =
    input.type === 'CATALOG'
      ? [{ type: 'CATALOG', text: 'View catalog' }]
      : input.type === 'MULTI_PRODUCT'
        ? [{ type: 'MPM', text: 'View items' }]
        : input.buttons.map((b) => toButton(b, flows));
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  return components;
}

/**
 * Submits a template for review. It is stored with the provider's status (usually PENDING), never faked as approved.
 * Submitting a saved draft (`draftId`) turns that draft into the submitted template.
 */
export async function createTemplate(
  workspace: WorkspaceDoc,
  conn: ConnectionDoc,
  user: UserDoc,
  input: TemplateInput,
  draftId?: Types.ObjectId,
): Promise<TemplateDoc> {
  const existing = await MessageTemplate.findOne({ workspaceId: workspace._id, name: input.name, language: input.language });
  if (existing && !(draftId && existing._id.equals(draftId))) {
    throw conflict('TEMPLATE_EXISTS', `A template named "${input.name}" already exists for ${input.language}.`);
  }
  const components = toComponents(input, await resolveForms(workspace._id, input));

  let created;
  try {
    created = await whatsappProvider().createTemplate(credentialsOf(conn), {
      name: input.name,
      language: input.language,
      category: input.category,
      components,
    });
  } catch (err) {
    throw providerToAppError(err, 'WhatsApp rejected this template');
  }

  const fields = {
    providerTemplateId: created.providerTemplateId,
    name: input.name,
    language: input.language,
    category: created.category || input.category,
    status: created.status,
    rejectedReason: null,
    components,
    templateType: input.type,
    draft: null,
    syncedAt: new Date(),
    updatedBy: user._id,
  };
  const draft = draftId ? await MessageTemplate.findOne({ _id: draftId, workspaceId: workspace._id, status: 'DRAFT' }) : null;
  if (draft) {
    draft.set(fields);
    return draft.save();
  }
  return MessageTemplate.create({ workspaceId: workspace._id, ...fields, createdBy: user._id });
}

/** Saves (or updates) a local draft. Nothing is sent to WhatsApp. */
export async function saveDraft(workspace: WorkspaceDoc, user: UserDoc, raw: z.infer<typeof draftInputSchema>, draftId?: Types.ObjectId): Promise<TemplateDoc> {
  const clash = await MessageTemplate.findOne({ workspaceId: workspace._id, name: raw.name, language: raw.language });
  if (clash && !(draftId && clash._id.equals(draftId))) {
    throw conflict('TEMPLATE_EXISTS', `A template named "${raw.name}" already exists for ${raw.language}.`);
  }
  const fields = {
    name: raw.name,
    language: raw.language,
    category: raw.category,
    templateType: raw.type,
    status: 'DRAFT',
    draft: raw,
    components: [],
    updatedBy: user._id,
  };
  if (draftId) {
    const doc = await MessageTemplate.findOne({ _id: draftId, workspaceId: workspace._id, status: 'DRAFT' });
    if (!doc) throw badRequest('NOT_A_DRAFT', 'Only drafts can be saved as drafts.');
    doc.set(fields);
    return doc.save();
  }
  return MessageTemplate.create({ workspaceId: workspace._id, ...fields, createdBy: user._id });
}

/** Edits a submitted template on WhatsApp (name and language never change). It goes back into review. */
export async function editTemplate(conn: ConnectionDoc, user: UserDoc, template: TemplateDoc, input: TemplateInput): Promise<TemplateDoc> {
  if (!template.providerTemplateId) throw badRequest('NOT_SUBMITTED', 'This template has not been submitted yet.');
  if (!['APPROVED', 'REJECTED', 'PAUSED'].includes(template.status)) {
    throw badRequest('TEMPLATE_NOT_EDITABLE', `Templates that are ${template.status.toLowerCase()} cannot be edited.`);
  }
  // Meta locks the category of approved templates.
  const changeCategory = template.status !== 'APPROVED' && input.category !== template.category;
  if (template.status === 'APPROVED' && input.category !== template.category) {
    throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { category: ['The category of an approved template cannot be changed.'] });
  }
  const components = toComponents({ ...input, name: template.name, language: template.language }, await resolveForms(template.workspaceId, input));
  try {
    await whatsappProvider().editTemplate(credentialsOf(conn), template.providerTemplateId, {
      ...(changeCategory ? { category: input.category } : {}),
      components,
    });
  } catch (err) {
    throw providerToAppError(err, 'WhatsApp rejected this edit');
  }
  template.set({ components, category: input.category, templateType: input.type, status: 'PENDING', rejectedReason: null, updatedBy: user._id, syncedAt: new Date() });
  return template.save();
}

/** Deletes on WhatsApp first (when submitted), then locally. */
export async function deleteTemplate(conn: ConnectionDoc | null, template: TemplateDoc): Promise<void> {
  if (template.providerTemplateId) {
    assertConnected(conn);
    try {
      await whatsappProvider().deleteTemplate(credentialsOf(conn), { providerTemplateId: template.providerTemplateId, name: template.name });
    } catch (err) {
      throw providerToAppError(err, 'Could not delete this template on WhatsApp');
    }
  }
  await MessageTemplate.deleteOne({ _id: template._id, workspaceId: template.workspaceId });
}

/** Copies a template into a new draft named `<name>_copy`, `<name>_copy_2`, ... */
export async function duplicateTemplate(user: UserDoc, template: TemplateDoc): Promise<TemplateDoc> {
  const base = `${template.name}_copy`.slice(0, 500);
  let name = base;
  for (let i = 2; await MessageTemplate.exists({ workspaceId: template.workspaceId, name, language: template.language }); i++) name = `${base}_${i}`;
  return MessageTemplate.create({
    workspaceId: template.workspaceId,
    name,
    language: template.language,
    category: template.category,
    status: 'DRAFT',
    templateType: template.templateType,
    components: template.components,
    // A copied draft keeps its builder input; copies of submitted templates are rebuilt from components.
    draft: template.draft ? { ...(template.draft as object), name } : null,
    createdBy: user._id,
    updatedBy: user._id,
  });
}

/** How many campaigns and flows reference each template. */
export async function templateUsage(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
  const usage = new Map(ids.map((id) => [id.toString(), { campaigns: 0, flows: 0 }]));
  if (!ids.length) return usage;
  const campaigns = await Campaign.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { workspaceId, templateId: { $in: ids } } },
    { $group: { _id: '$templateId', n: { $sum: 1 } } },
  ]);
  for (const c of campaigns) usage.get(c._id.toString())!.campaigns = c.n;

  const keys = ids.map(String);
  const flows = await Flow.find({ workspaceId, 'draftGraph.nodes.data.templateId': { $in: keys } }, { draftGraph: 1 });
  for (const f of flows) {
    const used = new Set(((f.draftGraph as { nodes?: { data?: { templateId?: unknown } }[] }).nodes ?? []).map((n) => String(n.data?.templateId ?? '')));
    for (const k of keys) if (used.has(k)) usage.get(k)!.flows += 1;
  }
  return usage;
}

// ---- Meta Template Library ----

export const libraryFiltersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  topic: z.string().regex(/^[A-Z_]{1,40}$/).optional(),
  usecase: z.string().regex(/^[A-Z_]{1,60}$/).optional(),
  industry: z.string().regex(/^[A-Z_]{1,40}$/).optional(),
  language: languageCode.optional(),
});

export const fromLibrarySchema = z.object({
  name: templateName,
  language: languageCode,
  libraryTemplateName: z.string().trim().min(1).max(512),
  buttonInputs: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('URL'), url: z.object({ base_url: z.string().url().max(2000), url_suffix_example: z.string().trim().max(2000).optional() }) }),
        z.object({ type: z.literal('PHONE_NUMBER'), phone_number: z.string().regex(/^\+\d{8,15}$/, 'Use +countrycode format.') }),
      ]),
    )
    .max(3)
    .default([]),
});

export async function listLibrary(conn: ConnectionDoc, filters: z.infer<typeof libraryFiltersSchema>): Promise<LibraryTemplate[]> {
  try {
    return await whatsappProvider().listLibraryTemplates(credentialsOf(conn), filters);
  } catch (err) {
    throw providerToAppError(err, 'Could not load the Meta template library');
  }
}

/** Library templates are pre-approved utility templates; Meta only needs the button details we fill in. */
export async function createFromLibrary(workspace: WorkspaceDoc, conn: ConnectionDoc, user: UserDoc, input: z.infer<typeof fromLibrarySchema>): Promise<TemplateDoc> {
  if (await MessageTemplate.exists({ workspaceId: workspace._id, name: input.name, language: input.language })) {
    throw conflict('TEMPLATE_EXISTS', `A template named "${input.name}" already exists for ${input.language}.`);
  }
  const provider = whatsappProvider();
  const creds = credentialsOf(conn);
  let created;
  let source: LibraryTemplate | undefined;
  try {
    source = (await provider.listLibraryTemplates(creds, { name: input.libraryTemplateName, language: input.language })).find((t) => t.name === input.libraryTemplateName);
    created = await provider.createFromLibrary(creds, input);
  } catch (err) {
    throw providerToAppError(err, 'WhatsApp rejected this template');
  }

  let urlIndex = 0;
  const components: TemplateComponent[] = source
    ? [
        ...(source.header ? [{ type: 'HEADER' as const, format: 'TEXT', text: source.header }] : []),
        { type: 'BODY', text: source.body, ...(source.bodyParams.length ? { example: { body_text: [source.bodyParams] } } : {}) },
        ...(source.buttons.length
          ? [
              {
                type: 'BUTTONS' as const,
                buttons: source.buttons.map((b) => {
                  const filled = b.type === 'URL' ? input.buttonInputs.filter((x) => x.type === 'URL')[urlIndex++] : input.buttonInputs.find((x) => x.type === b.type);
                  if (filled?.type === 'URL') return { type: 'URL', text: b.text, url: filled.url.base_url };
                  if (filled?.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: filled.phone_number };
                  return { type: b.type, text: b.text };
                }),
              },
            ]
          : []),
      ]
    : [];

  return MessageTemplate.create({
    workspaceId: workspace._id,
    providerTemplateId: created.providerTemplateId,
    name: input.name,
    language: input.language,
    category: created.category || 'UTILITY',
    status: created.status,
    components,
    templateType: 'CUSTOM' satisfies TemplateType,
    libraryTemplateName: input.libraryTemplateName,
    syncedAt: new Date(),
    createdBy: user._id,
    updatedBy: user._id,
  });
}

function placeholders(text: string): number[] {
  return [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
}

function isSequential(nums: number[]): boolean {
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  return unique.every((n, i) => n === i + 1);
}

export function assertConnected(conn: ConnectionDoc | null): asserts conn is ConnectionDoc {
  if (!conn) throw conflict('WHATSAPP_NOT_CONNECTED', 'Connect a WhatsApp number first.');
  if (conn.status !== 'connected') throw badRequest('WHATSAPP_CONNECTION_ERROR', 'The WhatsApp connection needs attention. Reconnect it first.');
}
