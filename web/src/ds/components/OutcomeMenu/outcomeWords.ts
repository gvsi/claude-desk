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
 * The setup interview's rules grouped by outcome (`OutcomeGroups`), each group's heading in the
 * setup board's words. Each sits beside its outcome's `OUTCOME_TONE` dot, so a group reads as the
 * outcome its rules have everywhere else.
 */
export const OUTCOME_GROUP_WORDS = {
  auto: 'Does on its own',
  ask: 'Asks you',
  never: 'Never does',
} as const satisfies Record<RuleMode, string>;

/**
 * The rule presets the owner can start from: the master plan's (`desk.presets.PRESETS`). There is no
 * "Custom" preset: rules the owner changes are simply the Desk's rules, with no preset of their own.
 */
export type RulesPreset = 'ask_first' | 'auto';

/**
 * The presets' names and what each sets, in order, in the signed presets board's words: the Rules
 * page's "Start from a preset" menu (`PresetMenu`) offers each by its label and description. The
 * descriptions describe the master plan's preset cards (`desk.presets.PRESETS`);
 * `outcomeWords.test.ts` checks each claim against those cards, read from their generated export
 * (`web/src/api/presets.gen.json`).
 */
export const PRESET_WORDS = [
  { value: 'ask_first', label: 'Ask me first', description: 'Quotes, bookings, documents and payments wait for your answer.' },
  {
    value: 'auto',
    label: 'Recommended rules',
    description: 'Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first.',
  },
] as const satisfies readonly { value: RulesPreset; label: string; description: string }[];
