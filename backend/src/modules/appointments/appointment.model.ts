import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
// ai_assistant: booked by the AI agent in chat; flow: a Flow Builder step; manual / api as named.
export const APPOINTMENT_SOURCES = ['ai_assistant', 'flow', 'manual', 'api'] as const;

const appointmentSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    service: { type: String, required: true, trim: true, maxlength: 120 },
    startAt: { type: Date, required: true },
    durationMinutes: { type: Number, min: 5, max: 24 * 60, default: 30 },
    status: { type: String, enum: APPOINTMENT_STATUSES, default: 'scheduled' },
    source: { type: String, enum: APPOINTMENT_SOURCES, default: 'manual' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    statusChangedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
appointmentSchema.plugin(tenantScoped);
appointmentSchema.index({ workspaceId: 1, startAt: 1 });
appointmentSchema.index({ workspaceId: 1, contactId: 1 });

export type AppointmentDoc = HydratedDocument<InferSchemaType<typeof appointmentSchema>>;
export const Appointment = model('Appointment', appointmentSchema);
