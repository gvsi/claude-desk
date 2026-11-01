import type { RuleRowProps } from '../../ds/index.ts';
import { DEFAULT_SIDE } from './changeRows.ts';

/** A tool no rule of the owner's covers: the default ask, in the house rules' words. */
export function defaultRow(tool: string): RuleRowProps {
  return { rule: { card_id: `default:${tool}`, mode: DEFAULT_SIDE.mode, reason: DEFAULT_SIDE.reason }, words: [...DEFAULT_SIDE.words] };
}
