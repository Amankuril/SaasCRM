import { Router } from 'express';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { Contact } from '../contacts/contact.model.js';
import { ensureTags } from '../contacts/contact.import.js';
import { findOrCreateContact, normalizePhone } from '../contacts/contact.service.js';
import { requireScope } from '../developer/apiKey.service.js';
import { enroll, exitWhere, updateEnrollmentData } from './sequence.engine.js';
import type { Graph } from './sequence.graph.js';
import { Sequence, SequenceEnrollment, SequenceEvent, SequenceVersion } from './sequence.model.js';
import { stepLabels } from './sequence.routes.js';

const data = z.record(z.string().regex(/^[a-zA-Z0-9_]{1,40}$/), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).default({});
const phone = z.string().trim().min(5).max(30);

/** Mounted inside the public API (/api/v1, API key auth). Same key as the rest of Zeta Connect. */
export const sequencePublicRouter = Router();

async function liveSequence(workspaceId: unknown, id: unknown) {
  const seq = await Sequence.findOne({ _id: objectId(id, 'Sequence'), workspaceId });
  if (!seq) throw notFound('Sequence not found.');
  return seq;
}

/** Up to 100 contacts per call; a result per contact (enrolled / already_in / opted_out / invalid…). */
sequencePublicRouter.post('/sequences/:sequenceId/enroll', requireScope('sequences:run'), async (req, res) => {
  const input = parse(z.object({ contacts: z.array(z.object({ phone, name: z.string().trim().max(200).optional(), data })).min(1).max(100) }), req.body);
  const workspace = req.workspace!;
  const seq = await liveSequence(workspace._id, req.params.sequenceId);
  if (seq.status !== 'active') throw new AppError(409, 'SEQUENCE_NOT_ACTIVE', 'This sequence is not live. Publish or resume it first.');
  const results = [];
  for (const c of input.contacts) {
    const e164 = normalizePhone(c.phone, workspace.country);
    if (!e164) {
      results.push({ phone: c.phone, result: 'invalid' });
      continue;
    }
    if (!(await Contact.exists({ workspaceId: workspace._id, phoneE164: e164 }))) await assertWithinLimit(workspace._id, 'contacts', await Contact.countDocuments({ workspaceId: workspace._id }));
    const contact = await findOrCreateContact(workspace._id, e164, 'api');
    if (c.name && !contact.name) {
      contact.name = c.name;
      await contact.save();
    }
    const { result, enrollment } = await enroll(seq, contact, { via: 'api', data: c.data });
    results.push({ phone: e164, result, enrollment_id: enrollment?.id ?? null });
  }
  res.json({ data: results });
});

/**
 * Something happened to a contact: the event becomes a tag (which can trigger
 * sequences or reach a goal), and `data` updates their live sequences (a new date
 * moves their dated reminders).
 */
sequencePublicRouter.post('/sequences/events', requireScope('sequences:run'), async (req, res) => {
  const input = parse(z.object({ phone, event: z.string().trim().min(1).max(40), data }), req.body);
  const workspace = req.workspace!;
  const e164 = normalizePhone(input.phone, workspace.country);
  if (!e164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  const contact = await Contact.findOne({ workspaceId: workspace._id, phoneE164: e164 });
  if (!contact) throw notFound('No contact with this phone number.');
  const updated = await updateEnrollmentData(workspace._id, contact._id, input.data);
  const tagId = (await ensureTags(workspace._id, [input.event])).get(input.event.toLowerCase())!;
  if (!contact.tags.some((t) => t.equals(tagId))) {
    contact.tags.push(tagId);
    await contact.save();
  }
  res.json({ data: { phone: e164, tag: input.event, sequences_updated: updated } });
});

sequencePublicRouter.post('/sequences/:sequenceId/exit', requireScope('sequences:run'), async (req, res) => {
  const input = parse(z.object({ phone, reason: z.string().trim().max(200).default('removed by API') }), req.body);
  const workspace = req.workspace!;
  const seq = await liveSequence(workspace._id, req.params.sequenceId);
  const e164 = normalizePhone(input.phone, workspace.country);
  const contact = e164 ? await Contact.findOne({ workspaceId: workspace._id, phoneE164: e164 }).select('_id').lean() : null;
  if (!contact) throw notFound('No contact with this phone number.');
  const exited = await exitWhere({ workspaceId: workspace._id, sequenceId: seq._id, contactId: contact._id, test: false }, 'removed', `API: ${input.reason}`);
  res.json({ data: { phone: e164, exited: exited > 0 } });
});

sequencePublicRouter.get('/sequences/:sequenceId/contacts/:phone', requireScope('sequences:run'), async (req, res) => {
  const workspace = req.workspace!;
  const seq = await liveSequence(workspace._id, req.params.sequenceId);
  const e164 = normalizePhone(String(req.params.phone), workspace.country);
  const contact = e164 ? await Contact.findOne({ workspaceId: workspace._id, phoneE164: e164 }).select('_id').lean() : null;
  const e = contact ? await SequenceEnrollment.findOne({ workspaceId: workspace._id, sequenceId: seq._id, contactId: contact._id, test: false }).sort({ enrolledAt: -1 }).lean() : null;
  if (!e) throw notFound('This contact has not been in the sequence.');
  const version = e.versionId ? await SequenceVersion.findOne({ _id: e.versionId, workspaceId: workspace._id }).select('graph').lean() : null;
  const labels = stepLabels((version?.graph as Graph) ?? { steps: [] });
  const history = await SequenceEvent.find({ workspaceId: workspace._id, enrollmentId: e._id }).sort({ createdAt: 1, _id: 1 }).limit(200).lean();
  res.json({
    data: {
      phone: e164,
      status: e.status,
      outcome: e.outcome ?? null,
      current_step: e.active && e.currentStepId ? (labels.get(e.currentStepId)?.label ?? null) : null,
      next_run_at: e.active ? (e.nextRunAt ?? null) : null,
      enrolled_at: e.enrolledAt,
      exited_at: e.exitedAt ?? null,
      exit_reason: e.exitReason ?? null,
      data: e.data ?? {},
      history: history.map((h) => ({ at: h.createdAt, step: h.stepId ? (labels.get(h.stepId)?.label ?? h.stepId) : null, type: h.type, result: h.result, reason: h.reason ?? null })),
    },
  });
});
