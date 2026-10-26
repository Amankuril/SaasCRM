import { Router } from 'express';
import { z } from 'zod';
import { parse, timezoneSchema } from '../../lib/validate.js';
import { loadWorkspace, requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { auditRouter } from '../audit/audit.routes.js';
import { invitationRouter } from '../invitations/invitation.routes.js';
import { campaignRouter } from '../campaigns/campaign.routes.js';
import { segmentRouter } from '../campaigns/segment.routes.js';
import { aiRouter } from '../ai/ai.routes.js';
import { analyticsRouter } from '../analytics/analytics.routes.js';
import { billingRouter } from '../billing/billing.routes.js';
import { getEntitlements } from '../billing/billing.service.js';
import { developerRouter } from '../developer/developer.routes.js';
import { contactRouter } from '../contacts/contact.routes.js';
import { flowRouter } from '../flows/flow.routes.js';
import { formRouter } from '../forms/form.routes.js';
import { tagRouter } from '../contacts/tag.routes.js';
import { conversationRouter } from '../inbox/conversation.routes.js';
import { messageRouter } from '../messages/message.routes.js';
import { templateRouter } from '../templates/template.routes.js';
import { autoReplyRouter } from '../autoreplies/autoReply.routes.js';
import { connectionRouter } from '../whatsapp/connection.routes.js';
import { memberRouter } from './member.routes.js';
import { toPublicWorkspace } from './workspace.model.js';
import { createWorkspace, listUserWorkspaces, workspaceContext } from './workspace.service.js';

const workspaceFields = {
  name: z.string().trim().min(2, 'Business name must be at least 2 characters.').max(100),
  timezone: timezoneSchema,
  country: z.string().trim().length(2, 'Use a 2-letter country code.').toUpperCase(),
  currency: z.string().trim().length(3, 'Use a 3-letter currency code.').toUpperCase(),
  industry: z.string().trim().max(60).nullish(),
};

const createSchema = z.object(workspaceFields);
const updateSchema = z
  .object(workspaceFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

/** Mounted at /api/workspaces behind requireAuth. */
export const workspacesRouter = Router();

workspacesRouter.get('/', async (req, res) => {
  res.json({ workspaces: await listUserWorkspaces(req.user!._id) });
});

workspacesRouter.post('/', async (req, res) => {
  const input = parse(createSchema, req.body);
  const workspace = await createWorkspace(req.user!, input);
  await audit(req, { workspaceId: workspace._id, action: 'workspace.created', targetType: 'workspace', targetId: workspace.id });
  res.status(201).json({ workspace: { ...toPublicWorkspace(workspace), role: 'owner' } });
});

// Everything below is scoped to one workspace the user is a member of.
const scoped = Router({ mergeParams: true });
workspacesRouter.use('/:workspaceId', loadWorkspace, scoped);

scoped.get('/', requirePermission('workspace:read'), async (req, res) => {
  const e = await getEntitlements(req.workspace!._id);
  const s = e.subscription;
  res.json({
    ...workspaceContext(req.workspace!, req.membership!),
    // Enough for the app-wide plan banner; details live on the Billing page.
    subscription: { planCode: s.planCode, planName: e.plan.name, status: s.status, access: e.access, trialEndsAt: s.trialEndsAt, graceEndsAt: s.graceEndsAt, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, features: e.features },
  });
});

scoped.patch('/', requirePermission('workspace:update'), async (req, res) => {
  const changes = parse(updateSchema, req.body);
  const workspace = req.workspace!;
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, workspace.get(k)]));
  workspace.set(changes);
  await workspace.save();
  await audit(req, {
    workspaceId: workspace._id,
    action: 'workspace.updated',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { before, after: changes },
  });
  res.json(workspaceContext(workspace, req.membership!));
});

scoped.use('/members', memberRouter);
scoped.use('/invitations', invitationRouter);
scoped.use('/audit-logs', auditRouter);
scoped.use('/whatsapp', connectionRouter);
scoped.use('/templates', templateRouter);
scoped.use('/messages', messageRouter);
scoped.use('/contacts', contactRouter);
scoped.use('/tags', tagRouter);
scoped.use('/conversations', conversationRouter);
scoped.use('/campaigns', campaignRouter);
scoped.use('/segments', segmentRouter);
scoped.use('/flows', flowRouter);
scoped.use('/auto-replies', autoReplyRouter);
scoped.use('/ai', aiRouter);
scoped.use('/forms', formRouter);
scoped.use('/developer', developerRouter);
scoped.use('/billing', billingRouter);
scoped.use('/analytics', analyticsRouter);
