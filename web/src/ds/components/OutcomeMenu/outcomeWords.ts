import type { RuleCard } from '../../../api/contracts.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/** What a rule card does with a request it covers: `auto`, `ask` or `never`. */
export type RuleMode = RuleCard['mode'];

/** Each outcome in the owner's words, wherever a rule's outcome shows: Allow, Ask me first or Never. */
export const OUTCOME_WORDS = {
  auto: 'Allow',
  ask: 'Ask me first',
  never: 'Never',
} as const satisfies Record<RuleMode, string>;

/** Each outcome's dot, beside its words: allow is handled, ask me first held, never refused. */
export const OUTCOME_TONE = {
  auto: 'handled',
  ask: 'held',
  never: 'refused',
} as const satisfies Record<RuleMode, StatusTone>;

/**
 * An outcome in words: its one word, and nothing else. A limit lives in the rule's sentence
 * (`ruleSentence`: "Claude can send payment links up to $300"), never in the outcome.
 */
export function outcomePhrase(mode: RuleMode): string {
  return OUTCOME_WORDS[mode];
}

/**
 * Rules grouped by outcome (`OutcomeGroups`, and Rules' own groups), each group headed by its
 * outcome's word beside its `OUTCOME_TONE` dot, so a group reads as the outcome its rules have
 * everywhere else.
 */
export const OUTCOME_GROUP_WORDS = OUTCOME_WORDS;

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
