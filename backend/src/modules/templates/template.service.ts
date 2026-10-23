import { z } from 'zod';
import { badRequest, conflict } from '../../lib/errors.js';
import type { UserDoc } from '../auth/user.model.js';
import { credentialsOf, providerToAppError } from '../whatsapp/connection.service.js';
import type { ConnectionDoc } from '../whatsapp/connection.model.js';
import { whatsappProvider, type TemplateComponent } from '../whatsapp/provider/index.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { MessageTemplate, countVariables, type TemplateDoc } from './template.model.js';

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

const variableText = (max: number) => z.string().trim().min(1).max(max);

export const createTemplateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores only.')
      .max(512),
    language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Use a language code like en, en_US or hi.'),
    // Authentication templates have a fixed Meta structure and are added later.
    category: z.enum(['MARKETING', 'UTILITY']),
    header: z.object({ text: variableText(60), example: z.string().trim().max(60).optional() }).optional(),
    body: z.object({ text: variableText(1024), examples: z.array(z.string().trim().min(1).max(200)).default([]) }),
    footer: z.object({ text: variableText(60) }).optional(),
    buttons: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('QUICK_REPLY'), text: variableText(25) }),
          z.object({ type: z.literal('URL'), text: variableText(25), url: z.string().url().max(2000) }),
          z.object({ type: z.literal('PHONE_NUMBER'), text: variableText(25), phone: z.string().regex(/^\+\d{8,15}$/, 'Use +countrycode format.') }),
        ]),
      )
      .max(10)
      .default([]),
  })
  .superRefine((t, ctx) => {
    const bodyVars = placeholders(t.body.text);
    if (!isSequential(bodyVars)) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Variables must be numbered {{1}}, {{2}}, ... in order.' });
    }
    if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(t.body.text)) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'WhatsApp does not allow the body to start or end with a variable.' });
    }
    if (t.body.examples.length !== countVariables(t.body.text)) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Give one example value for each body variable.' });
    }
    if (t.header) {
      const headerVars = placeholders(t.header.text);
      if (headerVars.length > 1 || (headerVars.length === 1 && headerVars[0] !== 1)) {
        ctx.addIssue({ code: 'custom', path: ['header'], message: 'The header can have at most one variable, {{1}}.' });
      }
      if (headerVars.length === 1 && !t.header.example) {
        ctx.addIssue({ code: 'custom', path: ['header'], message: 'Give an example value for the header variable.' });
      }
    }
  });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export function toComponents(input: CreateTemplateInput): TemplateComponent[] {
  const components: TemplateComponent[] = [];
  if (input.header) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: input.header.text,
      ...(countVariables(input.header.text) ? { example: { header_text: [input.header.example] } } : {}),
    });
  }
  components.push({
    type: 'BODY',
    text: input.body.text,
    ...(input.body.examples.length ? { example: { body_text: [input.body.examples] } } : {}),
  });
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer.text });
  if (input.buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: input.buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : b.type === 'PHONE_NUMBER'
            ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone }
            : { type: 'QUICK_REPLY', text: b.text },
      ),
    });
  }
  return components;
}

/** Submits a template for review. It is stored with the provider's status (usually PENDING), never faked as approved. */
export async function createTemplate(workspace: WorkspaceDoc, conn: ConnectionDoc, user: UserDoc, input: CreateTemplateInput): Promise<TemplateDoc> {
  if (await MessageTemplate.exists({ workspaceId: workspace._id, name: input.name, language: input.language })) {
    throw conflict('TEMPLATE_EXISTS', `A template named "${input.name}" already exists for ${input.language}.`);
  }
  const components = toComponents(input);

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

  return MessageTemplate.create({
    workspaceId: workspace._id,
    providerTemplateId: created.providerTemplateId,
    name: input.name,
    language: input.language,
    category: created.category || input.category,
    status: created.status,
    components,
    syncedAt: new Date(),
    createdBy: user._id,
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
