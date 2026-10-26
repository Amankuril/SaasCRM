import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { Types } from 'mongoose';
import { Contact, type ContactDoc } from './contact.model.js';

/**
 * Normalizes user-entered numbers to E.164 ("+919812345678"). Numbers without a
 * country code are read in the workspace's default country.
 */
export function normalizePhone(input: string, defaultCountry?: string): string | null {
  const phone = parsePhoneNumberFromString(input.trim(), defaultCountry as CountryCode | undefined);
  return phone?.isValid() ? phone.number : null;
}

/**
 * Numbers from a contact-list upload. With `international`, every number already
 * starts with its country code ("919812345678" or "+91 98123 45678") and is used as
 * written; otherwise numbers without one are read in `country`. Only checks that
 * the number is possible (right length), so new number ranges aren't rejected.
 */
export function normalizeImportPhone(input: string, opts: { international: boolean; country?: string }): string | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  const candidates = opts.international || raw.startsWith('+') ? [`+${digits}`] : [raw, `+${digits}`];
  for (const candidate of candidates) {
    const phone = parsePhoneNumberFromString(candidate, opts.international ? undefined : (opts.country as CountryCode | undefined));
    if (phone?.isPossible()) return phone.number;
  }
  return null;
}

/** WhatsApp ids are E.164 digits without "+". */
export function phoneFromWaId(waId: string): string {
  return `+${waId.replace(/\D/g, '')}`;
}

/** Upserts the sender. `created` tells "new contact" triggers that this is a first message. */
export async function recordInboundContact(
  workspaceId: Types.ObjectId,
  phoneE164: string,
  profileName: string | null,
  at: Date,
): Promise<{ contact: ContactDoc; created: boolean }> {
  const res = await Contact.findOneAndUpdate(
    { workspaceId, phoneE164 },
    {
      $setOnInsert: { workspaceId, phoneE164, source: 'whatsapp_inbound' },
      ...(profileName ? { $set: { profileName } } : {}),
      $max: { lastInboundAt: at },
    },
    { upsert: true, new: true, includeResultMetadata: true },
  );
  return { contact: res.value as ContactDoc, created: !res.lastErrorObject?.updatedExisting };
}

export async function findOrCreateContact(workspaceId: Types.ObjectId, phoneE164: string, source: string): Promise<ContactDoc> {
  return Contact.findOneAndUpdate(
    { workspaceId, phoneE164 },
    { $setOnInsert: { workspaceId, phoneE164, source } },
    { upsert: true, new: true },
  ) as Promise<ContactDoc>;
}

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Free-form (non-template) messages are only allowed within 24h of the customer's last message. */
export function isInServiceWindow(contact: { lastInboundAt?: Date | null }, now = Date.now()): boolean {
  return !!contact.lastInboundAt && now - contact.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}
