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

/**
 * The rule presets the owner can start from: the master plan's (`desk.presets.PRESETS`). There is no
 * "Custom" preset: rules the owner changes are simply the Desk's rules.
 */
export type RulesPreset = 'ask_first' | 'auto';

/**
 * The two presets the Rules page's "Start from a preset" menu offers, in order: each with its title
 * and a one-line description of what it does. The descriptions describe the master plan's preset
 * cards (`desk.presets.PRESETS`); `outcomeWords.test.ts` checks each claim against those cards, read
 * from their generated export (`web/src/api/presets.gen.json`).
 */
export const PRESET_ITEMS = [
  { value: 'ask_first', title: 'Ask me first', description: 'Quotes, bookings, documents and payments wait for your answer.' },
  {
    value: 'auto',
    title: 'Recommended rules',
    description: 'Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first.',
  },
] as const satisfies readonly { value: RulesPreset; title: string; description: string }[];
