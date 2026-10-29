import { AtSign, Bot, FolderOpen, Hourglass, MessageSquare, Star, UserRound, UserRoundX, type LucideIcon } from 'lucide-react';
import type { ConversationStatus, InboxView } from '../../lib/api';

/** Entries of the inbox navigation; each chat list is a view of conversations plus a default status. */
export const NAV_LISTS = {
  open: { label: 'Open Chats', view: 'all', status: 'open', icon: MessageSquare },
  all: { label: 'All', view: 'all', status: 'all', icon: FolderOpen },
  mine: { label: 'Assigned to me', view: 'mine', status: 'open', icon: UserRound },
  mentions: { label: 'Mentions', view: 'mentions', status: 'all', icon: AtSign },
  unassigned: { label: 'Unassigned', view: 'unassigned', status: 'open', icon: UserRoundX },
  starred: { label: 'Starred', view: 'starred', status: 'all', icon: Star },
  waiting: { label: 'Waiting for a person', view: 'waiting', status: 'open', icon: Hourglass },
  ai: { label: 'AI Agent Chats', view: 'ai', status: 'all', icon: Bot },
} satisfies Record<string, { label: string; view: InboxView; status: ConversationStatus | 'all'; icon: LucideIcon }>;
export type NavList = keyof typeof NAV_LISTS;
