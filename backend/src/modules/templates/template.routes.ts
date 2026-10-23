import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { getConnection } from '../whatsapp/connection.service.js';
import { MessageTemplate, toPublicTemplate } from './template.model.js';
import { assertConnected, createTemplate, createTemplateSchema, syncTemplates } from './template.service.js';

const listSchema = z.object({
  status: z.string().trim().toUpperCase().optional(),
  q: z.string().trim().max(100).optional(),
});

/** Mounted at /api/workspaces/:workspaceId/templates (workspace already loaded). */
export const templateRouter = Router({ mergeParams: true });

templateRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { status, q } = parse(listSchema, req.query);
  const templates = await MessageTemplate.find({
    workspaceId: req.workspace!._id,
    ...(status ? { status } : {}),
    ...(q ? { name: { $regex: q.replace(/[^a-z0-9_]/gi, ''), $options: 'i' } } : {}),
  }).sort({ name: 1, language: 1 });
  res.json({ templates: templates.map(toPublicTemplate) });
});

templateRouter.get('/:templateId', requirePermission('workspace:read'), async (req, res) => {
  const template = await MessageTemplate.findOne({ _id: objectId(req.params.templateId, 'Template'), workspaceId: req.workspace!._id });
  if (!template) throw notFound('Template not found.');
  res.json({ template: toPublicTemplate(template) });
});

templateRouter.post('/sync', requirePermission('templates:manage'), async (req, res) => {
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const result = await syncTemplates(req.workspace!, conn);
  res.json(result);
});

templateRouter.post('/', requirePermission('templates:manage'), async (req, res) => {
  const input = parse(createTemplateSchema, req.body);
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const template = await createTemplate(req.workspace!, conn, req.user!, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'template.submitted',
    targetType: 'template',
    targetId: template.id,
    metadata: { name: template.name, language: template.language, category: template.category },
  });
  res.status(201).json({ template: toPublicTemplate(template) });
});
