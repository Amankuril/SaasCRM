/**
 * Date (Reminder) event categories. Each one has its own fields, date type, repeat
 * options and default timing, so setups never share a form or a schedule.
 */
export const CATEGORY_KEYS = [
  'birthdays',
  'anniversaries',
  'payments',
  'installments',
  'appointments',
  'offers',
  'documents',
  'contracts',
  'healthcare',
  'employees',
  'custom',
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const RECURRENCES = ['none', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom_days'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RULE_UNITS = ['minute', 'hour', 'day', 'week'] as const;
export type RuleUnit = (typeof RULE_UNITS)[number];
export interface ReminderRule {
  when: 'before' | 'on' | 'after';
  value: number;
  unit: RuleUnit;
}

export interface CategoryField {
  key: string;
  label: string;
  type: 'text' | 'amount' | 'select';
  options?: string[];
  required?: boolean;
  example: string;
  /** Column headings recognised automatically when a file is imported. */
  aliases?: string[];
}

export interface ReminderCategory {
  key: CategoryKey;
  name: string;
  description: string;
  /** Who the record is about. */
  person: string;
  dateLabel: string;
  dateAliases: string[];
  /** `datetime` events carry a time of day and can be reminded hours before. */
  dateKind: 'date' | 'datetime';
  /** The year may be missing in the data (birthdays written as 14/08). */
  yearOptional?: boolean;
  fields: CategoryField[];
  recurrences: Recurrence[];
  defaultRecurrence: Recurrence;
  defaultRules: ReminderRule[];
  /** Reminders after the date, sent until the record is marked done. */
  followUps: boolean;
  /** What "done" is called, e.g. paid or renewed. */
  doneLabel: string | null;
  /** Fields that tell two records of one person apart (besides the phone number). */
  identity: ('name' | 'date' | 'time' | string)[];
  sample: string;
}

const before = (value: number, unit: RuleUnit): ReminderRule => ({ when: 'before', value, unit });
const onDate: ReminderRule = { when: 'on', value: 0, unit: 'day' };
const after = (value: number, unit: RuleUnit): ReminderRule => ({ when: 'after', value, unit });

export const CATEGORIES: ReminderCategory[] = [
  {
    key: 'birthdays',
    name: 'Birthdays',
    description: 'Personalized wishes, greetings or offers for each customer',
    person: 'Customer',
    dateLabel: 'Birthday',
    dateAliases: ['birthday', 'birth date', 'birthdate', 'date of birth', 'dob'],
    dateKind: 'date',
    yearOptional: true,
    fields: [{ key: 'offer', label: 'Offer or gift', type: 'text', example: '20% off', aliases: ['gift', 'discount'] }],
    recurrences: ['yearly'],
    defaultRecurrence: 'yearly',
    defaultRules: [onDate],
    followUps: false,
    doneLabel: null,
    identity: ['name'],
    sample: 'Hi {name}, happy birthday from {business_name}. Enjoy {offer} this week.',
  },
  {
    key: 'anniversaries',
    name: 'Anniversaries',
    description: 'Personal, business or partnership anniversaries',
    person: 'Customer',
    dateLabel: 'Anniversary date',
    dateAliases: ['anniversary', 'anniversary date', 'wedding date', 'marriage date'],
    dateKind: 'date',
    yearOptional: true,
    fields: [
      { key: 'anniversary_type', label: 'Anniversary type', type: 'select', options: ['Wedding', 'Business', 'Partnership', 'Customer since'], example: 'Wedding', aliases: ['type'] },
      { key: 'partner_name', label: 'Partner name', type: 'text', example: 'Priya', aliases: ['partner', 'spouse'] },
    ],
    recurrences: ['yearly'],
    defaultRecurrence: 'yearly',
    defaultRules: [onDate],
    followUps: false,
    doneLabel: null,
    identity: ['name', 'anniversary_type'],
    sample: 'Hi {name}, {business_name} wishes you a happy {anniversary_type} anniversary.',
  },
  {
    key: 'payments',
    name: 'Payment & Invoice',
    description: 'Due dates for each client, with notice a day before and follow-ups',
    person: 'Client',
    dateLabel: 'Due date',
    dateAliases: ['due date', 'due', 'payment date', 'invoice date', 'pay by'],
    dateKind: 'date',
    fields: [
      { key: 'amount', label: 'Amount', type: 'amount', required: true, example: '₹4,500', aliases: ['total', 'balance', 'amount due'] },
      { key: 'invoice_number', label: 'Invoice number', type: 'text', example: 'INV-1042', aliases: ['invoice', 'invoice no', 'bill no', 'reference'] },
      { key: 'payment_link', label: 'Payment link', type: 'text', example: 'https://pay.example.com/1042', aliases: ['link', 'upi'] },
    ],
    recurrences: ['none', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom_days'],
    defaultRecurrence: 'monthly',
    defaultRules: [before(1, 'day'), after(3, 'day')],
    followUps: true,
    doneLabel: 'Paid',
    identity: ['invoice_number'],
    sample: 'Hi {name}, your invoice {invoice_number} of {amount} is due on {date}.',
  },
  {
    key: 'installments',
    name: 'Installments, EMI & SIP',
    description: 'Loan EMIs, SIPs, chit or savings schemes on the same day each cycle',
    person: 'Customer',
    dateLabel: 'First installment date',
    dateAliases: ['installment date', 'emi date', 'sip date', 'first due date', 'start date', 'due date'],
    dateKind: 'date',
    fields: [
      { key: 'amount', label: 'Installment amount', type: 'amount', required: true, example: '₹12,000', aliases: ['emi', 'emi amount', 'sip amount'] },
      { key: 'plan_type', label: 'Plan type', type: 'select', options: ['Loan EMI', 'SIP', 'Chit fund', 'Savings scheme', 'Other'], example: 'Loan EMI', aliases: ['type', 'plan'] },
      { key: 'account_number', label: 'Loan or account number', type: 'text', example: 'LN-88213', aliases: ['loan no', 'account', 'folio'] },
    ],
    recurrences: ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom_days'],
    defaultRecurrence: 'monthly',
    defaultRules: [before(2, 'day'), onDate],
    followUps: true,
    doneLabel: 'Paid',
    identity: ['account_number', 'plan_type'],
    sample: 'Hi {name}, installment {cycle_number} of {amount} for {account_number} is due on {date}.',
  },
  {
    key: 'appointments',
    name: 'Appointments & Sessions',
    description: 'One upcoming appointment per client, with a nudge an hour before',
    person: 'Client',
    dateLabel: 'Appointment date',
    dateAliases: ['appointment date', 'appointment', 'session date', 'booking date', 'date'],
    dateKind: 'datetime',
    fields: [
      { key: 'service', label: 'Service or session', type: 'text', example: 'Dental cleaning', aliases: ['session', 'treatment'] },
      { key: 'staff', label: 'With', type: 'text', example: 'Dr. Mehta', aliases: ['doctor', 'trainer', 'consultant'] },
      { key: 'location', label: 'Location', type: 'text', example: 'Andheri clinic', aliases: ['address', 'branch', 'venue'] },
    ],
    recurrences: ['none', 'weekly', 'monthly', 'custom_days'],
    defaultRecurrence: 'none',
    defaultRules: [before(1, 'day'), before(1, 'hour')],
    followUps: false,
    doneLabel: 'Completed',
    identity: ['date', 'time'],
    sample: 'Hi {name}, your {service} appointment is on {date} at {time}.',
  },
  {
    key: 'offers',
    name: 'Offers on a Set Date',
    description: 'Discounts or loyalty rewards on a date that differs for each customer',
    person: 'Customer',
    dateLabel: 'Offer date',
    dateAliases: ['offer date', 'reward date', 'campaign date', 'date', 'valid till'],
    dateKind: 'date',
    fields: [
      { key: 'offer', label: 'Offer', type: 'text', required: true, example: 'Flat 25% off', aliases: ['discount', 'reward', 'deal'] },
      { key: 'coupon_code', label: 'Coupon code', type: 'text', example: 'LOYAL25', aliases: ['coupon', 'code'] },
      { key: 'valid_until', label: 'Valid until', type: 'text', example: '31 Dec 2026', aliases: ['expiry', 'valid till'] },
    ],
    recurrences: ['none', 'monthly', 'yearly'],
    defaultRecurrence: 'none',
    defaultRules: [onDate],
    followUps: false,
    doneLabel: 'Redeemed',
    identity: ['date', 'coupon_code'],
    sample: 'Hi {name}, {offer} is ready for you at {business_name}. Use {coupon_code}.',
  },
  {
    key: 'documents',
    name: 'Document & Licence Expiry',
    description: 'Insurance, warranty, licence or passport expiry for each person',
    person: 'Holder',
    dateLabel: 'Expiry date',
    dateAliases: ['expiry date', 'expiry', 'expires on', 'expiration date', 'valid till'],
    dateKind: 'date',
    fields: [
      { key: 'document_type', label: 'Document type', type: 'select', options: ['Insurance', 'Warranty', 'Driving licence', 'Passport', 'Vehicle registration', 'Permit', 'Other'], required: true, example: 'Insurance', aliases: ['document', 'type'] },
      { key: 'document_number', label: 'Document number', type: 'text', example: 'POL-77120', aliases: ['policy no', 'licence no', 'number'] },
    ],
    recurrences: ['none', 'yearly'],
    defaultRecurrence: 'none',
    defaultRules: [before(30, 'day'), before(7, 'day'), before(1, 'day')],
    followUps: true,
    doneLabel: 'Renewed',
    identity: ['document_type', 'document_number'],
    sample: 'Hi {name}, your {document_type} {document_number} expires on {date}.',
  },
  {
    key: 'contracts',
    name: 'Contract & Subscription Dates',
    description: 'Renewals, contract ends and trial expiries with advance notice',
    person: 'Client',
    dateLabel: 'Renewal or end date',
    dateAliases: ['renewal date', 'end date', 'contract end', 'trial end', 'expiry date'],
    dateKind: 'date',
    fields: [
      { key: 'contract_type', label: 'Type', type: 'select', options: ['Renewal', 'Contract end', 'Trial expiry'], example: 'Renewal', aliases: ['type'] },
      { key: 'plan_name', label: 'Contract or plan name', type: 'text', required: true, example: 'Annual maintenance', aliases: ['plan', 'contract', 'subscription'] },
      { key: 'amount', label: 'Renewal amount', type: 'amount', example: '₹18,000', aliases: ['price', 'fee'] },
    ],
    recurrences: ['none', 'monthly', 'quarterly', 'half_yearly', 'yearly'],
    defaultRecurrence: 'none',
    defaultRules: [before(15, 'day'), before(3, 'day'), after(2, 'day')],
    followUps: true,
    doneLabel: 'Renewed',
    identity: ['plan_name', 'contract_type'],
    sample: 'Hi {name}, your {plan_name} is due for renewal on {date}.',
  },
  {
    key: 'healthcare',
    name: 'Healthcare & Wellness',
    description: 'Vaccination, check-up and therapy dates for each patient',
    person: 'Patient',
    dateLabel: 'Visit date',
    dateAliases: ['visit date', 'checkup date', 'check-up date', 'vaccination date', 'therapy date', 'next visit'],
    dateKind: 'date',
    fields: [
      { key: 'care_type', label: 'Care type', type: 'select', options: ['Vaccination', 'Check-up', 'Therapy', 'Follow-up', 'Test'], required: true, example: 'Check-up', aliases: ['type', 'visit type'] },
      { key: 'detail', label: 'Vaccine, test or therapy', type: 'text', example: 'Typhoid booster', aliases: ['vaccine', 'test', 'therapy'] },
      { key: 'doctor', label: 'Doctor', type: 'text', example: 'Dr. Rao', aliases: ['physician'] },
    ],
    recurrences: ['none', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom_days'],
    defaultRecurrence: 'none',
    defaultRules: [before(1, 'day')],
    followUps: true,
    doneLabel: 'Completed',
    identity: ['name', 'care_type', 'detail'],
    sample: 'Hi {name}, your {care_type} with {doctor} is on {date}.',
  },
  {
    key: 'employees',
    name: 'Employee & Team Events',
    description: 'Staff birthdays, work anniversaries and training reminders',
    person: 'Employee',
    dateLabel: 'Event date',
    dateAliases: ['event date', 'date', 'birthday', 'joining date', 'training date'],
    dateKind: 'date',
    yearOptional: true,
    fields: [
      { key: 'event_type', label: 'Event type', type: 'select', options: ['Birthday', 'Work anniversary', 'Training'], required: true, example: 'Work anniversary', aliases: ['type', 'event'] },
      { key: 'department', label: 'Department', type: 'text', example: 'Sales', aliases: ['team'] },
    ],
    recurrences: ['yearly', 'none'],
    defaultRecurrence: 'yearly',
    defaultRules: [onDate],
    followUps: false,
    doneLabel: null,
    identity: ['name', 'event_type'],
    sample: 'Hi {name}, happy {event_type} from everyone at {business_name}.',
  },
  {
    key: 'custom',
    name: 'And More',
    description: 'Create your own date-based reminder with its own fields',
    person: 'Contact',
    dateLabel: 'Date',
    dateAliases: ['date', 'event date', 'reminder date'],
    dateKind: 'datetime',
    fields: [],
    recurrences: ['none', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom_days'],
    defaultRecurrence: 'none',
    defaultRules: [before(1, 'day')],
    followUps: true,
    doneLabel: 'Done',
    identity: ['date', 'time'],
    sample: 'Hi {name}, a reminder from {business_name} for {date}.',
  },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
export function categoryOf(key: string): ReminderCategory {
  const c = BY_KEY.get(key as CategoryKey);
  if (!c) throw new Error(`Unknown reminder category ${key}`);
  return c;
}

/** Stable id of a rule: the same timing always has the same id, so it can never send twice. */
export const ruleId = (r: ReminderRule) => (r.when === 'on' ? 'on' : `${r.when}-${r.value}-${r.unit}`);

/** Values every category offers besides its own fields. */
export const COMMON_VARIABLES = [
  { key: 'name', label: 'Name', example: 'Rahul' },
  { key: 'first_name', label: 'First name', example: 'Rahul' },
  { key: 'date', label: 'Event date', example: '1 Dec 2026' },
  { key: 'time', label: 'Event time', example: '11:30 AM' },
  { key: 'days_left', label: 'Days left', example: '1' },
  { key: 'business_name', label: 'Business name', example: 'Your business' },
  { key: 'phone', label: 'Phone number', example: '+91 98100 10000' },
  { key: 'cycle_number', label: 'Cycle number', example: '3' },
  { key: 'years', label: 'Years completed', example: '5' },
] as const;
