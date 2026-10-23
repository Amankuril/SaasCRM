import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, notFound } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', result.error.flatten().fieldErrors);
  }
  return result.data;
}

/** Parses a route id; malformed ids are reported as "not found" so they leak nothing. */
export function objectId(value: unknown, what = 'Resource'): Types.ObjectId {
  if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) throw notFound(`${what} not found.`);
  return new Types.ObjectId(value);
}

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.');

// Constructing a formatter accepts IANA aliases (Asia/Kolkata vs Asia/Calcutta), unlike
// Intl.supportedValuesOf, whose canonical names vary by ICU version.
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z.string().trim().max(64).refine(isValidTimeZone, 'Unknown timezone.');
