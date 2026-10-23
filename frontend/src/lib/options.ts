import type { Role } from './api';

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including billing and the WhatsApp connection.' },
  admin: { label: 'Admin', description: 'Manages contacts, campaigns, flows, templates and the team.' },
  manager: { label: 'Manager', description: 'Views reports, assigns chats and supervises agents.' },
  agent: { label: 'Agent', description: 'Handles assigned conversations.' },
  analyst: { label: 'Analyst', description: 'Read-only access to dashboards and reports.' },
};

export const COUNTRIES: { code: string; name: string; currency: string }[] = [
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
  { code: 'SG', name: 'Singapore', currency: 'SGD' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
  { code: 'AU', name: 'Australia', currency: 'AUD' },
  { code: 'NP', name: 'Nepal', currency: 'NPR' },
  { code: 'BD', name: 'Bangladesh', currency: 'BDT' },
  { code: 'LK', name: 'Sri Lanka', currency: 'LKR' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
];

export const CURRENCIES = [...new Set(COUNTRIES.map((c) => c.currency))].sort();

export const INDUSTRIES = [
  'Healthcare / Clinic',
  'Retail / E-commerce',
  'Education',
  'Real estate',
  'Restaurant / Food',
  'Travel',
  'Finance / Insurance',
  'Salon / Wellness',
  'Agency',
  'Other',
];

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function timeZones(current?: string): string[] {
  const zones = Intl.supportedValuesOf?.('timeZone') ?? ['UTC'];
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

export function formatDate(value: string, withTime = false): string {
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
function tzOffset(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ts);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ts / 1000) * 1000;
}

/** "2026-10-24T10:30" meant in `timeZone` (e.g. the workspace's) -> ISO UTC string. */
export function zonedLocalToIso(local: string, timeZone: string): string {
  const [date = '', time = '00:00'] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  let utc = guess - tzOffset(guess, timeZone);
  utc = guess - tzOffset(utc, timeZone); // correct across DST changes
  return new Date(utc).toISOString();
}

export function formatInZone(value: string, timeZone: string): string {
  return new Date(value).toLocaleString(undefined, { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
