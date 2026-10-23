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
