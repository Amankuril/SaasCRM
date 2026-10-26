import express, { Router } from 'express';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { credentialsOf, getConnection, providerToAppError } from '../whatsapp/connection.service.js';
import { whatsappProvider } from '../whatsapp/provider/index.js';
import { CommunityTemplate, stripMedia, toPublicCommunityTemplate } from './community.model.js';
import { MessageTemplate, TEMPLATE_TYPES, inferTemplateType, toPublicTemplate } from './template.model.js';
import {
  assertConnected,
  createFromLibrary,
  createTemplate,
  deleteTemplate,
  draftInputSchema,
  duplicateTemplate,
  editTemplate,
  fromLibrarySchema,
  libraryFiltersSchema,
  listLibrary,
  saveDraft,
  syncTemplates,
  templateInputSchema,
  templateUsage,
} from './template.service.js';

const listSchema = z.object({
  status: z.string().trim().toUpperCase().optional(),
  q: z.string().trim().max(100).optional(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  type: z.enum(TEMPLATE_TYPES).optional(),
  favorite: z.enum(['true', 'false']).optional(),
  // Without `limit` every template is returned (pickers in campaigns, flows and the inbox).
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'application/pdf'];

/** Mounted at /api/workspaces/:workspaceId/templates (workspace already loaded). */
export const templateRouter = Router({ mergeParams: true });

templateRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { status, q, category, type, favorite, page, limit } = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const docs = await MessageTemplate.find({
    workspaceId,
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(favorite === 'true' ? { isFavorite: true } : {}),
    ...(q ? { name: { $regex: q.replace(/[^a-z0-9_]/gi, ''), $options: 'i' } } : {}),
  })
    .sort(limit ? { createdAt: -1 } : { name: 1, language: 1 })
    .populate('createdBy updatedBy', 'name');

  // The type is inferred for synced templates, so it is filtered here rather than in Mongo.
  const matching = type ? docs.filter((t) => (t.templateType ?? inferTemplateType(t.category, t.components as never)) === type) : docs;
  const pageDocs = limit ? matching.slice((page - 1) * limit, page * limit) : matching;
  const usage = limit ? await templateUsage(workspaceId, pageDocs.map((t) => t._id)) : null;
  res.json({
    templates: pageDocs.map((t) => toPublicTemplate(t, usage?.get(t.id))),
    total: matching.length,
    page,
    limit: limit ?? matching.length,
  });
});

templateRouter.post('/sync', requirePermission('templates:manage'), async (req, res) => {
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const result = await syncTemplates(req.workspace!, conn);
  res.json(result);
});

/** Uploads a sample header/card media file to Meta; the returned handle goes into the template. */
templateRouter.post(
  '/media',
  requirePermission('templates:manage'),
  express.raw({ type: MEDIA_TYPES, limit: '16mb' }),
  async (req, res) => {
    const mimeType = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!MEDIA_TYPES.includes(mimeType) || !Buffer.isBuffer(req.body) || !req.body.length) {
      throw badRequest('INVALID_MEDIA', 'Upload a JPG or PNG image, an MP4 video or a PDF document.');
    }
    const fileName = String(req.headers['x-file-name'] ?? 'sample').replace(/[^\w.-]/g, '_').slice(0, 100) || 'sample';
    const conn = await getConnection(req.workspace!._id, true);
    assertConnected(conn);
    try {
      const handle = await whatsappProvider().uploadTemplateMedia(credentialsOf(conn), { data: req.body, mimeType, fileName });
      res.status(201).json({ handle });
    } catch (err) {
      throw providerToAppError(err, 'Could not upload this file to WhatsApp');
    }
  },
);

// ---- Meta Template Library ----

templateRouter.get('/library', requirePermission('workspace:read'), async (req, res) => {
  const filters = parse(libraryFiltersSchema, req.query);
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  res.json({ templates: await listLibrary(conn, filters) });
});

templateRouter.post('/library', requirePermission('templates:manage'), async (req, res) => {
  const input = parse(fromLibrarySchema, req.body);
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const template = await createFromLibrary(req.workspace!, conn, req.user!, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'template.submitted',
    targetType: 'template',
    targetId: template.id,
    metadata: { name: template.name, language: template.language, library: input.libraryTemplateName },
  });
  res.status(201).json({ template: toPublicTemplate(template) });
});

// ---- Community Library ----

const communityListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  type: z.enum(TEMPLATE_TYPES).optional(),
});

templateRouter.get('/community', requirePermission('workspace:read'), async (req, res) => {
  const { q, category, type } = parse(communityListSchema, req.query);
  const items = await CommunityTemplate.find({
    ...(category ? { category } : {}),
    ...(type ? { templateType: type } : {}),
    ...(q ? { name: { $regex: q.replace(/[^a-z0-9_]/gi, ''), $options: 'i' } } : {}),
  })
    .sort({ uses: -1, createdAt: -1 })
    .limit(200);
  res.json({ templates: items.map((t) => toPublicCommunityTemplate(t, req.workspace!.id)) });
});

/** Counts a reuse; the builder is then prefilled client-side from the returned content. */
templateRouter.post('/community/:communityId/use', requirePermission('templates:manage'), async (req, res) => {
  const item = await CommunityTemplate.findOneAndUpdate({ _id: objectId(req.params.communityId, 'Template') }, { $inc: { uses: 1 } }, { new: true });
  if (!item) throw notFound('Template not found.');
  res.json({ template: toPublicCommunityTemplate(item, req.workspace!.id) });
});

templateRouter.delete('/community/:communityId', requirePermission('templates:manage'), async (req, res) => {
  const item = await CommunityTemplate.findOne({ _id: objectId(req.params.communityId, 'Template') });
  if (!item) throw notFound('Template not found.');
  if (!item.contributorWorkspaceId.equals(req.workspace!._id)) throw forbidden('Only the business that shared a template can remove it.');
  await item.deleteOne();
  res.status(204).end();
});

// ---- Single template ----

async function loadTemplate(req: express.Request) {
  const template = await MessageTemplate.findOne({ _id: objectId(req.params.templateId, 'Template'), workspaceId: req.workspace!._id }).populate(
    'createdBy updatedBy',
    'name',
  );
  if (!template) throw notFound('Template not found.');
  return template;
}

templateRouter.get('/:templateId', requirePermission('workspace:read'), async (req, res) => {
  const template = await loadTemplate(req);
  const usage = await templateUsage(req.workspace!._id, [template._id]);
  res.json({ template: toPublicTemplate(template, usage.get(template.id)) });
});

/** Submits a template for review; `?draftId=` submits a saved draft. */
templateRouter.post('/', requirePermission('templates:manage'), async (req, res) => {
  const input = parse(templateInputSchema, req.body);
  const draftId = typeof req.query.draftId === 'string' ? objectId(req.query.draftId, 'Template') : undefined;
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const template = await createTemplate(req.workspace!, conn, req.user!, input, draftId);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'template.submitted',
    targetType: 'template',
    targetId: template.id,
    metadata: { name: template.name, language: template.language, category: template.category, type: input.type },
  });
  res.status(201).json({ template: toPublicTemplate(template) });
});

/** Saves a new draft, or updates one with `?draftId=`. */
templateRouter.post('/drafts', requirePermission('templates:manage'), async (req, res) => {
  const input = parse(draftInputSchema, req.body);
  const draftId = typeof req.query.draftId === 'string' ? objectId(req.query.draftId, 'Template') : undefined;
  const template = await saveDraft(req.workspace!, req.user!, input, draftId);
  res.status(draftId ? 200 : 201).json({ template: toPublicTemplate(template) });
});

templateRouter.put('/:templateId', requirePermission('templates:manage'), async (req, res) => {
  const template = await loadTemplate(req);
  const input = parse(templateInputSchema, req.body);
  const conn = await getConnection(req.workspace!._id, true);
  assertConnected(conn);
  const updated = await editTemplate(conn, req.user!, template, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'template.edited',
    targetType: 'template',
    targetId: updated.id,
    metadata: { name: updated.name, language: updated.language },
  });
  res.json({ template: toPublicTemplate(updated) });
});

templateRouter.delete('/:templateId', requirePermission('templates:manage'), async (req, res) => {
  const template = await loadTemplate(req);
  const conn = template.providerTemplateId ? await getConnection(req.workspace!._id, true) : null;
  await deleteTemplate(conn, template);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'template.deleted',
    targetType: 'template',
    targetId: template.id,
    metadata: { name: template.name, language: template.language },
  });
  res.status(204).end();
});

templateRouter.post('/:templateId/duplicate', requirePermission('templates:manage'), async (req, res) => {
  const template = await loadTemplate(req);
  const copy = await duplicateTemplate(req.user!, template);
  res.status(201).json({ template: toPublicTemplate(copy) });
});

templateRouter.post('/:templateId/favorite', requirePermission('workspace:read'), async (req, res) => {
  const { favorite } = parse(z.object({ favorite: z.boolean() }), req.body);
  const template = await loadTemplate(req);
  template.isFavorite = favorite;
  await template.save();
  res.json({ template: toPublicTemplate(template) });
});

/** Shares an approved template with every business on the platform. */
templateRouter.post('/:templateId/contribute', requirePermission('templates:manage'), async (req, res) => {
  const template = await loadTemplate(req);
  if (template.status !== 'APPROVED') throw badRequest('TEMPLATE_NOT_APPROVED', 'Only approved templates can be shared with the community.');
  const workspace = req.workspace!;
  const item = await CommunityTemplate.findOneAndUpdate(
    { contributorWorkspaceId: workspace._id, name: template.name, language: template.language },
    {
      $set: {
        contributorName: workspace.name,
        category: template.category,
        templateType: template.templateType ?? inferTemplateType(template.category, template.components as never),
        components: stripMedia(template.components as never),
      },
    },
    { upsert: true, new: true },
  );
  await audit(req, { workspaceId: workspace._id, action: 'template.contributed', targetType: 'template', targetId: template.id, metadata: { name: template.name } });
  res.status(201).json({ template: toPublicCommunityTemplate(item, workspace.id) });
});
