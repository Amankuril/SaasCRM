/**
 * The public integration contract: API key scopes and outgoing webhook events.
 * Adding a capability = one entry here + the endpoint (or emit call) that uses it.
 */

export const API_SCOPES = [
  'contacts:read',
  'contacts:write',
  'messages:send',
  'messages:read',
  'templates:read',
  'conversations:read',
  'campaigns:read',
  'flows:read',
  'flows:run',
  'forms:read',
  'webhooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'contacts:read': 'List and read contacts',
  'contacts:write': 'Create and update contacts and their tags',
  'messages:send': 'Send WhatsApp messages (templates any time, text inside the 24h window)',
  'messages:read': 'Read messages and their delivery status',
  'templates:read': 'List message templates',
  'conversations:read': 'List conversations',
  'campaigns:read': 'List broadcast campaigns and their reports',
  'flows:read': 'List flows',
  'flows:run': 'Start a contact on an "API" flow',
  'forms:read': 'List forms and read submissions',
  'webhooks:manage': 'Create and manage webhook endpoints',
};

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.status_updated',
  'contact.created',
  'contact.opted_out',
  'conversation.assigned',
  'conversation.resolved',
  'form.submitted',
  'campaign.completed',
  'flow.completed',
  'ai.handoff',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

export const EVENT_DESCRIPTIONS: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  'message.received': 'A customer sent a WhatsApp message',
  'message.status_updated': 'A sent message became sent, delivered, read or failed',
  'contact.created': 'A new contact was added (first WhatsApp message, dashboard or API; CSV imports are not sent)',
  'contact.opted_out': 'A contact opted out of WhatsApp messages',
  'conversation.assigned': 'A conversation was assigned or unassigned',
  'conversation.resolved': 'A conversation was resolved',
  'form.submitted': 'A customer submitted a WhatsApp form',
  'campaign.completed': 'A broadcast campaign finished sending',
  'flow.completed': 'A contact finished a flow',
  'ai.handoff': 'The AI agent handed a conversation to the team',
};

/** Contract version sent with every webhook and in API responses. */
export const API_VERSION = '2026-10-01';
