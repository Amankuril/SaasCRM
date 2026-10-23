import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { autoReply } from '../ai/ai.service.js';
import { hasAccess } from '../billing/billing.service.js';
import { Workspace } from '../workspaces/workspace.model.js';
import type { ContactDoc } from '../contacts/contact.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { deliverReply, exitExecutions, startExecution } from './engine.js';
import { Flow, FlowExecution, FlowVersion, type FlowVersionDoc } from './flow.model.js';

/** Consent keywords are handled by the opt-out logic and never start flows. */
const CONSENT_WORDS = /^\s*(stop|unsubscribe|opt[\s-]?out|stop all|start|subscribe|opt[\s-]?in)\s*[.!]?\s*$/i;

async function activeVersions(workspaceId: Types.ObjectId): Promise<FlowVersionDoc[]> {
  const flows = await Flow.find({ workspaceId, status: 'active', publishedVersionId: { $ne: null } }).select('publishedVersionId').lean();
  return FlowVersion.find({ workspaceId, _id: { $in: flows.map((f) => f.publishedVersionId) } }).sort({ publishedAt: 1 });
}

function messageText(message: { type: string; content: Record<string, unknown> }): string {
  const c = message.content as { text?: string; title?: string };
  return String(c.text ?? c.title ?? '').trim();
}

/**
 * Routes one inbound customer message through automations:
 *  1. a run waiting for this contact's reply gets it;
 *  2. runs sleeping in a delay exit if their flow says "exit on reply";
 *  3. otherwise the first matching active flow starts (keyword > new contact > any message).
 * Never throws: automation problems must not break message ingestion.
 */
export async function onInboundMessage(
  workspaceId: Types.ObjectId,
  contact: ContactDoc,
  message: { id: string; type: string; content: Record<string, unknown>; form?: { formId: string; valid: boolean; data: Record<string, unknown> } },
  createdContact: boolean,
): Promise<void> {
  try {
    // Read-only plans: messages are stored, but no automation or AI runs.
    if (!(await hasAccess(workspaceId))) return;
    const waiting = await FlowExecution.findOne({ workspaceId, contactId: contact._id, status: 'waiting', 'waiting.kind': 'reply' }).sort({ updatedAt: -1 });
    if (waiting && (await deliverReply(waiting, message))) return;

    const sleeping = await FlowExecution.find({ workspaceId, contactId: contact._id, status: 'waiting', 'waiting.kind': 'delay' }).select('flowId').lean();
    if (sleeping.length) {
      const exitFlows = await Flow.find({ workspaceId, _id: { $in: sleeping.map((s) => s.flowId) }, 'settings.exitOnReply': true }).select('_id').lean();
      if (exitFlows.length) await exitExecutions({ workspaceId, contactId: contact._id, flowId: { $in: exitFlows.map((f) => f._id) } }, 'contact_replied');
    }

    // A form submission only starts "form submitted" flows (never keywords or the AI).
    if (message.form) {
      if (!message.form.valid || contact.consent?.status === 'opted_out') return;
      const versions = await activeVersions(workspaceId);
      const match = versions.find((v) => v.trigger?.event === 'form_submitted' && String(v.trigger.formId) === message.form!.formId);
      if (match) await startExecution(match, contact._id, { type: 'form_submitted', messageId: message.id, text: message.form.formId });
      return;
    }

    const text = messageText(message);
    if (CONSENT_WORDS.test(text) || contact.consent?.status === 'opted_out') return;
    const conv = await Conversation.findOne({ workspaceId, contactId: contact._id }).select('botPaused').lean();
    if (conv?.botPaused) return; // a human has taken over

    const versions = await activeVersions(workspaceId);
    const lower = text.toLowerCase();
    const keyword = versions.find((v) => {
      const t = v.trigger;
      if (t?.event !== 'keyword' || !lower) return false;
      return t.keywords.some((k) => (t.match === 'contains' ? lower.includes(k.toLowerCase()) : lower === k.toLowerCase()));
    });
    const chosen =
      keyword ??
      (createdContact ? versions.find((v) => v.trigger?.event === 'new_contact') : undefined) ??
      versions.find((v) => v.trigger?.event === 'any_message');
    if (chosen) {
      await startExecution(chosen, contact._id, { type: chosen.trigger!.event, messageId: message.id, text: text.slice(0, 200) });
      return;
    }

    // No flow wants this message: let the AI agent answer it (if enabled).
    const workspace = await Workspace.findById(workspaceId);
    if (workspace && workspace.status !== 'suspended') await autoReply(workspace, contact, { id: message.id, text });
  } catch (err) {
    logger.error({ err, contactId: contact.id }, 'Flow trigger handling failed');
  }
}

/** "Tag added" triggers (from a teammate editing a contact, or another flow). */
export async function onTagsAdded(workspaceId: Types.ObjectId, contactId: Types.ObjectId, tagIds: Types.ObjectId[], depth = 0): Promise<void> {
  if (!tagIds.length) return;
  try {
    const versions = await activeVersions(workspaceId);
    for (const v of versions) {
      const tagId = v.trigger?.event === 'tag_added' ? v.trigger.tagId : null;
      if (tagId && tagIds.some((t) => t.equals(tagId))) {
        await startExecution(v, contactId, { type: 'tag_added', text: tagId.toString() }, depth);
      }
    }
  } catch (err) {
    logger.error({ err, contactId: contactId.toString() }, 'Tag trigger handling failed');
  }
}
