import type { RuleCard } from '../../../api/contracts.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/** What a rule card does with a request it covers: `auto`, `ask` or `never`. */
export type RuleMode = RuleCard['mode'];

/** Each outcome in the owner's words, wherever a rule's outcome shows. */
export const OUTCOME_WORDS = {
  auto: 'Automatic',
  ask: 'Ask me first',
  never: 'Never',
} as const satisfies Record<RuleMode, string>;

/** Each outcome's dot, beside its words: automatic is handled, ask me first held, never refused. */
export const OUTCOME_TONE = {
  auto: 'handled',
  ask: 'held',
  never: 'refused',
} as const satisfies Record<RuleMode, StatusTone>;

/**
 * An outcome in words. An `auto` card with an amount limit holds anything above it for the owner
 * through its hold twin, so with `limit` (the screen's formatted amount, "$100") it reads
 * "Automatic up to $100; over $100, ask me first". No other mode shows a limit.
 */
export function outcomePhrase(mode: RuleMode, limit?: string): string {
  const shown = limit?.trim() ?? '';
  if (mode === 'auto' && shown !== '') return `${OUTCOME_WORDS.auto} up to ${shown}; over ${shown}, ask me first`;
  return OUTCOME_WORDS[mode];
}

/** The master plan's rule presets, the Desk's mode: Ask me first, Automatic or Custom. */
export type RulesPreset = 'ask_first' | 'auto' | 'custom';

/** The mode switch's options, in order, for the screen's `SegmentedControl`. */
export const PRESET_WORDS = [
  { value: 'ask_first', label: 'Ask me first' },
  { value: 'auto', label: 'Automatic' },
  { value: 'custom', label: 'Custom' },
] as const satisfies readonly { value: RulesPreset; label: string }[];

/**
 * What each mode means, under the mode switch. The two presets' captions describe the master
 * plan's preset cards (`desk.presets.PRESETS`): Automatic adds quotes at list price, weekday
 * bookings in opening hours and customers' own documents to what Ask me first already runs on its
 * own, and both ask before any payment. Custom is the owner's own rules.
 */
export const PRESET_CAPTIONS = {
  ask_first:
    'Claude asks you before it quotes, books, shares a document or takes a payment. It still finds open times, saves leads and confirms who people are.',
  auto: 'Claude quotes at list price, books weekdays in your hours and sends verified customers their own documents. Payments ask you first.',
  custom: 'Your own rules, tool by tool. Change any of them below.',
} as const satisfies Record<RulesPreset, string>;
