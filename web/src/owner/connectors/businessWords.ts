import type { BusinessToolDef } from '../../api/views.ts';
import type { RuleMode } from '../../ds/components/OutcomeMenu/outcomeWords.ts';
import { formatCents } from '../../lib/format.ts';

/** The signed words for the Desk's own jobs, shared by setup and Rules. */
export const BUSINESS_WORDS = {
  appointment: 'Appointment', length: 'Length', uses: 'Uses', asks: 'Asks', amount: 'Amount',
  urgent: 'Urgent', next: 'Next for you', setup: 'How it’s set up', jobs: 'Your Desk’s jobs',
  needsReview: 'Needs review', review: 'Review',
  lead: 'A job from your setup questions. Here’s how it’s set up; nothing runs until you turn it on.',
} as const;

export interface BusinessSetupRow { label: string; value: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Validate API text and configuration before drawing any part of a job. Unknown blocks stay out. */
export function isBusinessDef(value: unknown): value is BusinessToolDef {
  if (!record(value) || !text(value.title) || !text(value.description) || !record(value.config)) return false;
  const config = value.config;
  if (config.block === 'intake') return Array.isArray(config.questions) && config.questions.length > 0 && config.questions.every(text);
  if (config.block === 'purpose_payment') return text(config.purpose) && Number.isSafeInteger(config.amount_cents) && (config.amount_cents as number) > 0;
  if (config.block === 'urgent') return text(config.urgent_when);
  return config.block === 'typed_booking' && text(config.appointment_type) && Number.isSafeInteger(config.minutes) && (config.minutes as number) > 0;
}

export function businessLine(def: BusinessToolDef): string | null {
  if (!isBusinessDef(def)) return null;
  const config = def.config;
  if (config.block === 'typed_booking') return `${config.appointment_type}, ${config.minutes} minutes, in your opening hours`;
  if (config.block === 'intake') return `${config.questions.length} ${config.questions.length === 1 ? 'question' : 'questions'} before a booking`;
  if (config.block === 'purpose_payment') return `${config.purpose}, ${formatCents(config.amount_cents)}`;
  if (config.block === 'urgent') return `Urgent: ${config.urgent_when}`;
  return null;
}

/** Rules spells out an intake's questions; other jobs keep the shared configuration line. */
export function businessRulesDescription(def: BusinessToolDef): string | null {
  if (!isBusinessDef(def)) return null;
  return def.config.block === 'intake' ? `${BUSINESS_WORDS.asks}: ${def.config.questions.join(' ')}` : businessLine(def);
}

export function businessRows(def: BusinessToolDef, mode: RuleMode): BusinessSetupRow[] {
  if (!isBusinessDef(def)) return [];
  const config = def.config;
  const next = (value: string): BusinessSetupRow[] => mode === 'never' ? [] : [{ label: BUSINESS_WORDS.next, value }];
  if (config.block === 'typed_booking') return [
    { label: BUSINESS_WORDS.appointment, value: config.appointment_type },
    { label: BUSINESS_WORDS.length, value: `${config.minutes} minutes` },
    { label: BUSINESS_WORDS.uses, value: 'Your opening hours' },
    ...next(mode === 'auto' ? 'The booking shows in Today, with their answers' : 'You approve each request in Needs you'),
  ];
  if (config.block === 'intake') return [
    { label: BUSINESS_WORDS.asks, value: config.questions.join(' ') },
    ...next('Their answers show on the booking'),
  ];
  if (config.block === 'purpose_payment') return [
    { label: BUSINESS_WORDS.amount, value: formatCents(config.amount_cents) },
    { label: BUSINESS_WORDS.uses, value: 'Stripe' },
    ...next('Each payment shows in Today'),
  ];
  if (config.block === 'urgent') return [
    { label: BUSINESS_WORDS.urgent, value: config.urgent_when },
    { label: BUSINESS_WORDS.uses, value: 'Alerts you right away' },
  ];
  return [];
}

export function businessGlyph(config: BusinessToolDef['config']): 'calendar' | 'person' | 'card' | 'clock' | null {
  if (!record(config)) return null;
  if (config.block === 'typed_booking') return 'calendar';
  if (config.block === 'intake') return 'person';
  if (config.block === 'purpose_payment') return 'card';
  if (config.block === 'urgent') return 'clock';
  return null;
}
