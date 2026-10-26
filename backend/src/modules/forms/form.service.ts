import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { queueOutboundMessage } from '../messages/message.service.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { FORM_SCREEN_ID, validateSubmission, type FormField } from './flowJson.js';
import { Form, FormSubmission, type FormDoc, type SubmissionDoc } from './form.model.js';
import { newFlowToken, parseFlowToken } from './flowToken.js';

export { newFlowToken, parseFlowToken };

/** Sends the "open form" message. Needs the 24-hour window (it's an interactive message). */
export async function sendForm(
  workspace: WorkspaceDoc,
  contact: ContactDoc,
  form: FormDoc,
  opts: { text?: string; idempotencyKey?: string | null; flowExecutionId?: Types.ObjectId } = {},
) {
  if (form.status !== 'published' || !form.providerFlowId) throw new AppError(409, 'FORM_NOT_PUBLISHED', `Publish the form "${form.name}" before sending it.`);
  return queueOutboundMessage(
    workspace,
    null,
    {
      type: 'flow',
      to: contact.phoneE164,
      text: opts.text || form.intro || form.name,
      flowId: form.providerFlowId,
      flowToken: newFlowToken({ id: form.id as string, version: form.version }),
      ctaText: form.ctaText,
      screen: FORM_SCREEN_ID,
      formId: form.id as string,
      formName: form.name,
    },
    opts.idempotencyKey ?? null,
    opts.flowExecutionId ? { flowExecutionId: opts.flowExecutionId } : {},
  );
}

export interface HandledSubmission {
  submission: SubmissionDoc;
  form: FormDoc;
}

/**
 * Stores a WhatsApp Flow reply ("nfm_reply") as a form submission. Returns null
 * when the reply isn't one of our forms or the token was already used.
 */
export async function handleFormReply(
  workspace: WorkspaceDoc,
  contact: ContactDoc,
  message: { id: string; content: Record<string, unknown> },
): Promise<HandledSubmission | null> {
  let response: Record<string, unknown>;
  try {
    response = JSON.parse(String(message.content.response ?? '{}')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const token = typeof response.flow_token === 'string' ? response.flow_token : '';
  const parsed = parseFlowToken(token);
  if (!parsed) return null;
  // The token's form must belong to this workspace.
  const form = await Form.findOne({ _id: parsed.formId, workspaceId: workspace._id });
  if (!form) return null;

  const { flow_token: _token, ...data } = response;
  const fields = form.publishedFields as FormField[];
  const issues = validateSubmission(fields, data);

  let submission: SubmissionDoc;
  try {
    submission = await FormSubmission.create({
      workspaceId: workspace._id,
      formId: form._id,
      formVersion: parsed.version,
      contactId: contact._id,
      messageId: Types.ObjectId.isValid(message.id) ? message.id : null,
      flowToken: token,
      data,
      valid: issues.length === 0,
      issues,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null; // token already used
    throw err;
  }

  if (submission.valid) await copyToContact(workspace, contact, fields, data);
  await emitEvent(workspace._id, 'form.submitted', async () => ({
    submission: { id: submission.id as string, form_id: form.id as string, form_name: form.name, form_version: parsed.version, data, valid: submission.valid, issues, submitted_at: submission.submittedAt },
    contact: await contactPayload(workspace._id, contact._id),
  }));
  if (submission.valid) {
    if (form.successMessage) {
      await queueOutboundMessage(workspace, null, { type: 'text', to: contact.phoneE164, text: form.successMessage }, `form-ok:${submission.id}`).catch((err) =>
        logger.warn({ err }, 'Could not send form confirmation'),
      );
    }
  }
  return { submission, form };
}

async function copyToContact(workspace: WorkspaceDoc, contact: ContactDoc, fields: FormField[], data: Record<string, unknown>) {
  const set: Record<string, unknown> = {};
  for (const f of fields) {
    const value = data[f.key];
    if (!f.saveTo || value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (f.saveTo === 'name') set.name = text.slice(0, 200);
    else if (f.saveTo === 'email') set.email = text.toLowerCase().slice(0, 254);
    else set[`customFields.${f.saveTo.slice(7)}`] = text.slice(0, 500);
  }
  if (Object.keys(set).length) await Contact.updateOne({ _id: contact._id, workspaceId: workspace._id }, { $set: set });
}
