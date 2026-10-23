import { Schema, model } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * One open → resolved cycle of a conversation, written when it's resolved.
 * Inbox reports (first response, resolution time, agent workload) read these
 * instead of the live conversation, which only remembers its latest cycle.
 */
const conversationCycleSchema = new Schema({
  workspaceId: workspaceIdField,
  conversationId: { type: Schema.Types.ObjectId, required: true },
  assigneeId: { type: Schema.Types.ObjectId, default: null },
  openedAt: { type: Date, required: true },
  firstReplyAt: { type: Date, default: null },
  resolvedAt: { type: Date, required: true },
});
conversationCycleSchema.plugin(tenantScoped);
conversationCycleSchema.index({ workspaceId: 1, resolvedAt: -1 });

export const ConversationCycle = model('ConversationCycle', conversationCycleSchema);
