import type { BusinessToolDef } from '../../api/views.ts';
import type { RuleMode } from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';

/** The signed words for the Desk's own jobs, shared by setup and Rules. */
export const BUSINESS_WORDS = {
  appointment: 'Appointment', length: 'Length', uses: 'Uses', asks: 'Asks', amount: 'Amount',
  urgent: 'Urgent', next: 'Next for you', setup: 'How it’s set up', jobs: 'Your Desk’s jobs',
  needsReview: 'Needs review', review: 'Review',
  lead: 'A job from your setup questions. Here’s how it’s set up; nothing runs until you turn it on.',
} as const;

export interface BusinessSetupRow { label: string; value: string }

/**
 * The owner's own line per block, signed by the project owner.
 * The kernel's description_confirmed is Claude-facing and never shown to the owner.
 */
export const BUSINESS_OWNER_LINES = {
  intake: "Saves the person's name, contact details and answers to your questions, so you can follow up.",
  typed_booking: 'Books one open time on your calendar for this kind of appointment.',
  purpose_payment: 'Sends a secure payment link for this purpose, for the amount you set.',
  urgent: 'Takes an urgent callback request and alerts you right away.',
} as const satisfies Record<BusinessToolDef['config']['block'], string>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function businessOwnerLine(config: unknown): string | null {
  if (!record(config) || typeof config.block !== 'string' || !Object.hasOwn(BUSINESS_OWNER_LINES, config.block)) return null;
  return BUSINESS_OWNER_LINES[config.block as keyof typeof BUSINESS_OWNER_LINES];
}

// Pydantic's string bounds count Unicode code points, including empty and whitespace-only strings.
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' && [...value].length <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const integerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

/** Validate API text and configuration before drawing any part of a job. Unknown blocks stay out. */
export function isBusinessDef(value: unknown): value is BusinessToolDef {
  return record(value) && onlyKeys(value, ['title', 'description', 'config'])
    && boundedText(value.title, 60) && boundedText(value.description, 300) && isBusinessConfig(value.config);
}

function isBusinessConfig(config: unknown): config is BusinessToolDef['config'] {
  if (!record(config)) return false;
  if (config.block === 'intake') return onlyKeys(config, ['block', 'questions'])
    && Array.isArray(config.questions) && config.questions.length >= 1 && config.questions.length <= 5
    && config.questions.every((question) => boundedText(question, 120));
  if (config.block === 'purpose_payment') return onlyKeys(config, ['block', 'purpose', 'amount_cents'])
    && boundedText(config.purpose, 60) && integerInRange(config.amount_cents, 0, 1_000_000);
  if (config.block === 'urgent') return onlyKeys(config, ['block', 'urgent_when']) && boundedText(config.urgent_when, 300);
  return config.block === 'typed_booking' && onlyKeys(config, ['block', 'appointment_type', 'minutes'])
    && boundedText(config.appointment_type, 60) && integerInRange(config.minutes, 15, 60);
}

export function businessLine(def: BusinessToolDef): string | null {
  if (!isBusinessDef(def)) return null;
  return configLine(def.config);
}

function configLine(config: BusinessToolDef['config']): string | null {
  if (config.block === 'typed_booking') return `${config.appointment_type}, ${config.minutes} minutes, in your opening hours`;
  if (config.block === 'intake') return `${config.questions.length} ${config.questions.length === 1 ? 'question' : 'questions'} before a booking`;
  if (config.block === 'purpose_payment') return `${config.purpose}, ${formatCents(config.amount_cents)}`;
  if (config.block === 'urgent') return `Urgent: ${config.urgent_when}`;
  return null;
}

/** Rules spells out an intake's questions; other jobs keep the shared configuration line. */
export function businessRulesDescription(def: BusinessToolDef | null | undefined): string | null {
  if (!record(def) || !isBusinessConfig(def.config)) return null;
  return def.config.block === 'intake' ? `${BUSINESS_WORDS.asks}: ${def.config.questions.join(' ')}` : configLine(def.config);
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
