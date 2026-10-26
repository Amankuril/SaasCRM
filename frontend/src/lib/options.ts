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

/** Countries for WhatsApp number entry, most common for our customers first. */
export const DIAL_CODES: { iso: string; name: string; dial: string }[] = [
  { iso: 'IN', name: 'India', dial: '91' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso: 'US', name: 'United States', dial: '1' },
  { iso: 'GB', name: 'United Kingdom', dial: '44' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso: 'SG', name: 'Singapore', dial: '65' },
  { iso: 'NP', name: 'Nepal', dial: '977' },
  { iso: 'BD', name: 'Bangladesh', dial: '880' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso: 'PK', name: 'Pakistan', dial: '92' },
  { iso: 'CA', name: 'Canada', dial: '1' },
  { iso: 'AU', name: 'Australia', dial: '61' },
  { iso: 'NZ', name: 'New Zealand', dial: '64' },
  { iso: 'QA', name: 'Qatar', dial: '974' },
  { iso: 'KW', name: 'Kuwait', dial: '965' },
  { iso: 'OM', name: 'Oman', dial: '968' },
  { iso: 'BH', name: 'Bahrain', dial: '973' },
  { iso: 'MY', name: 'Malaysia', dial: '60' },
  { iso: 'ID', name: 'Indonesia', dial: '62' },
  { iso: 'PH', name: 'Philippines', dial: '63' },
  { iso: 'TH', name: 'Thailand', dial: '66' },
  { iso: 'VN', name: 'Vietnam', dial: '84' },
  { iso: 'HK', name: 'Hong Kong', dial: '852' },
  { iso: 'JP', name: 'Japan', dial: '81' },
  { iso: 'DE', name: 'Germany', dial: '49' },
  { iso: 'FR', name: 'France', dial: '33' },
  { iso: 'IT', name: 'Italy', dial: '39' },
  { iso: 'ES', name: 'Spain', dial: '34' },
  { iso: 'NL', name: 'Netherlands', dial: '31' },
  { iso: 'IE', name: 'Ireland', dial: '353' },
  { iso: 'ZA', name: 'South Africa', dial: '27' },
  { iso: 'NG', name: 'Nigeria', dial: '234' },
  { iso: 'KE', name: 'Kenya', dial: '254' },
  { iso: 'EG', name: 'Egypt', dial: '20' },
  { iso: 'BR', name: 'Brazil', dial: '55' },
  { iso: 'MX', name: 'Mexico', dial: '52' },
  { iso: 'FJ', name: 'Fiji', dial: '679' },
];
