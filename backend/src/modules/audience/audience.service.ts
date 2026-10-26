import type { Types } from 'mongoose';
import { Contact } from '../contacts/contact.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { ConversationNote } from '../inbox/note.model.js';
import { Message } from '../messages/message.model.js';
import { FollowUp } from './followUp.model.js';

/** Removes people and their conversation history, notes and follow-ups from a workspace. */
export async function deleteContactsData(workspaceId: Types.ObjectId, contactIds: Types.ObjectId[]): Promise<number> {
  const contactId = { $in: contactIds };
  await Promise.all([
    Message.deleteMany({ workspaceId, contactId }),
    ConversationNote.deleteMany({ workspaceId, contactId }),
    Conversation.deleteMany({ workspaceId, contactId }),
    FollowUp.deleteMany({ workspaceId, contactId }),
  ]);
  return (await Contact.deleteMany({ workspaceId, _id: contactId })).deletedCount;
}
