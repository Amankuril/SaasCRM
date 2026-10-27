import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { STAGE_COLORS } from '../audience/stage.model.js';

export const TASK_TYPES = ['task', 'ticket'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** A board column ("Open", "In Progress"...). Tasks store the stable `key`. */
const taskColumnSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    key: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, enum: STAGE_COLORS, default: 'gray' },
    order: { type: Number, default: 0 },
    // Moving a task here marks it done (for "overdue" and analytics).
    isDone: { type: Boolean, default: false },
  },
  { timestamps: true },
);
taskColumnSchema.plugin(tenantScoped);
taskColumnSchema.index({ workspaceId: 1, key: 1 }, { unique: true });
export type TaskColumnDoc = HydratedDocument<InferSchemaType<typeof taskColumnSchema>>;
export const TaskColumn = model('TaskColumn', taskColumnSchema);

/** A task or customer ticket on the Ticket / Task Board. */
const taskSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    // Human reference shown on cards, e.g. #12 (per workspace).
    number: { type: Number, required: true },
    type: { type: String, enum: TASK_TYPES, default: 'task' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    status: { type: String, required: true },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'medium' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    dueAt: { type: Date, default: null },
    // Position inside its column (lower first).
    position: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
taskSchema.plugin(tenantScoped);
taskSchema.index({ workspaceId: 1, number: 1 }, { unique: true });
taskSchema.index({ workspaceId: 1, status: 1, position: 1 });
taskSchema.index({ workspaceId: 1, contactId: 1 });
export type TaskDoc = HydratedDocument<InferSchemaType<typeof taskSchema>>;
export const Task = model('Task', taskSchema);

/** Per-workspace sequences (task numbers). */
const counterSchema = new Schema({ workspaceId: workspaceIdField, name: { type: String, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });
counterSchema.plugin(tenantScoped);
counterSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);
