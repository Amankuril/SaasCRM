import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** Internal team note on a conversation. Never sent to the customer. */
const noteSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    // Null for notes written by automations (AI agent, flows).
    authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    authorLabel: { type: String, default: null },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    // Teammates @mentioned in the note: it shows in their "Mentions".
    mentions: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
);

noteSchema.plugin(tenantScoped);
noteSchema.index({ workspaceId: 1, conversationId: 1, createdAt: -1 });
noteSchema.index({ workspaceId: 1, mentions: 1, createdAt: -1 });

export type NoteAttrs = InferSchemaType<typeof noteSchema>;
export const ConversationNote = model('ConversationNote', noteSchema);
