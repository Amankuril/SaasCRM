import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { csvCell } from '../../lib/csv.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { User } from '../auth/user.model.js';
import { Contact } from '../contacts/contact.model.js';
import { findOrCreateContact, normalizePhone } from '../contacts/contact.service.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { APPOINTMENT_SOURCES, APPOINTMENT_STATUSES, Appointment, type AppointmentDoc } from './appointment.model.js';

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  source: z.enum(APPOINTMENT_SOURCES).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const appointmentInput = z
  .object({
    // An existing contact, or a phone number (the contact is created if new).
    contactId: objectIdString.optional(),
    phone: z.string().trim().min(5).max(30).optional(),
    name: z.string().trim().max(200).optional(),
    service: z.string().trim().min(1, 'What is the appointment for?').max(120),
    startAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(5).max(24 * 60).default(30),
    notes: z.string().trim().max(2000).default(''),
    assigneeId: objectIdString.nullable().default(null),
  })
  .refine((v) => !!v.contactId || !!v.phone, { message: 'Choose a customer or enter a phone number.', path: ['phone'] });

const updateSchema = z.object({
  service: z.string().trim().min(1).max(120),
  startAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  notes: z.string().trim().max(2000),
  assigneeId: objectIdString.nullable(),
  status: z.enum(APPOINTMENT_STATUSES),
});

/** Mongo filter for the list and export (search matches service, customer name or phone). */
async function buildFilter(workspaceId: Types.ObjectId, input: z.infer<typeof listSchema>) {
  const filter: Record<string, unknown> = { workspaceId };
  if (input.source) filter.source = input.source;
  if (input.status) filter.status = input.status;
  if (input.from || input.to) filter.startAt = { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(input.to) } : {}) };
  if (input.q) {
    const rx = { $regex: escapeRegex(input.q), $options: 'i' };
    const digits = input.q.replace(/\D/g, '');
    const contactIds = await Contact.distinct('_id', { workspaceId, $or: [{ name: rx }, { profileName: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])] });
    filter.$or = [{ service: rx }, { contactId: { $in: contactIds } }];
  }
  return filter;
}

async function serialize(workspaceId: Types.ObjectId, items: AppointmentDoc[]) {
  const [contacts, users] = await Promise.all([
    Contact.find({ workspaceId, _id: { $in: items.map((a) => a.contactId) } }).select('name profileName phoneE164').lean(),
    User.find({ _id: { $in: items.map((a) => a.assigneeId).filter(Boolean) } }).select('name').lean(),
  ]);
  const contactById = new Map(contacts.map((c) => [c._id.toString(), c]));
  const userName = new Map(users.map((u) => [u._id.toString(), u.name]));
  return items.map((a) => {
    const c = contactById.get(a.contactId.toString());
    return {
      id: a.id as string,
      contact: c ? { id: c._id.toString(), name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 } : null,
      service: a.service,
      startAt: a.startAt,
      durationMinutes: a.durationMinutes,
      status: a.status,
      source: a.source,
      notes: a.notes,
      assignee: a.assigneeId ? { id: a.assigneeId.toString(), name: userName.get(a.assigneeId.toString()) ?? 'Former member' } : null,
      createdAt: a.createdAt,
    };
  });
}

async function checkAssignee(workspaceId: Types.ObjectId, assigneeId: string | null | undefined) {
  if (assigneeId && !(await WorkspaceMember.exists({ workspaceId, userId: assigneeId }))) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { assigneeId: ['Choose a teammate.'] });
}

async function load(req: Request) {
  const appointment = await Appointment.findOne({ _id: objectId(req.params.appointmentId, 'Appointment'), workspaceId: req.workspace!._id });
  if (!appointment) throw notFound('Appointment not found.');
  return appointment;
}

/** Mounted at /api/workspaces/:workspaceId/appointments. */
export const appointmentRouter = Router({ mergeParams: true });

appointmentRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter = await buildFilter(workspaceId, input);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const [items, total, upcoming, doneThisMonth, cancelled] = await Promise.all([
    Appointment.find(filter)
      .sort({ startAt: input.sort === 'oldest' ? 1 : -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit),
    Appointment.countDocuments(filter),
    Appointment.countDocuments({ workspaceId, status: 'scheduled', startAt: { $gte: now } }),
    Appointment.countDocuments({ workspaceId, status: 'completed', startAt: { $gte: monthStart, $lt: nextMonth } }),
    Appointment.countDocuments({ workspaceId, status: 'cancelled' }),
  ]);
  res.json({ appointments: await serialize(workspaceId, items), total, pages: Math.max(1, Math.ceil(total / input.limit)), stats: { upcoming, doneThisMonth, cancelled } });
});

appointmentRouter.get('/export', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const items = await Appointment.find(await buildFilter(workspaceId, input))
    .sort({ startAt: input.sort === 'oldest' ? 1 : -1 })
    .limit(20_000);
  const rows = await serialize(workspaceId, items);
  const lines = [['customer', 'phone', 'service', 'starts_at', 'duration_minutes', 'status', 'source', 'assigned_to', 'notes'].join(',')];
  for (const r of rows) {
    lines.push([r.contact?.name, r.contact?.phone, r.service, new Date(r.startAt).toISOString(), r.durationMinutes, r.status, r.source, r.assignee?.name, r.notes].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="appointments-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

appointmentRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(appointmentInput, req.body);
  const workspaceId = req.workspace!._id;
  await checkAssignee(workspaceId, input.assigneeId);
  let contactId: Types.ObjectId;
  if (input.contactId) {
    const contact = await Contact.findOne({ _id: input.contactId, workspaceId }).select('_id').lean();
    if (!contact) throw notFound('Contact not found.');
    contactId = contact._id;
  } else {
    const phone = normalizePhone(input.phone!, req.workspace!.country);
    if (!phone) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
    const contact = await findOrCreateContact(workspaceId, phone, 'appointment');
    if (input.name && !contact.name) await Contact.updateOne({ _id: contact._id, workspaceId }, { name: input.name });
    contactId = contact._id;
  }
  const appointment = await Appointment.create({
    workspaceId,
    contactId,
    service: input.service,
    startAt: new Date(input.startAt),
    durationMinutes: input.durationMinutes,
    notes: input.notes,
    assigneeId: input.assigneeId,
    source: 'manual',
    createdBy: req.user!._id,
  });
  publish(req.workspace!.id as string, { type: 'appointments.changed' });
  res.status(201).json({ appointment: (await serialize(workspaceId, [appointment]))[0] });
});

appointmentRouter.patch('/:appointmentId', requirePermission('contacts:manage'), async (req, res) => {
  const appointment = await load(req);
  const input = parse(updateSchema.partial(), req.body);
  await checkAssignee(req.workspace!._id, input.assigneeId);
  const { startAt, status, ...rest } = input;
  appointment.set(rest);
  if (startAt) appointment.startAt = new Date(startAt);
  if (status && status !== appointment.status) appointment.set({ status, statusChangedAt: new Date() });
  await appointment.save();
  publish(req.workspace!.id as string, { type: 'appointments.changed' });
  res.json({ appointment: (await serialize(req.workspace!._id, [appointment]))[0] });
});

appointmentRouter.delete('/:appointmentId', requirePermission('contacts:manage'), async (req, res) => {
  const appointment = await load(req);
  await Appointment.deleteOne({ _id: appointment._id, workspaceId: req.workspace!._id });
  publish(req.workspace!.id as string, { type: 'appointments.changed' });
  res.status(204).end();
});
