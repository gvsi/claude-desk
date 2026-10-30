import type { Effect } from '../../../api/contracts.ts';

/** What a tool does, by its weightiest effect: the first in this list that the tool has. */
const EFFECT_LINES = [
  ['pay_out', 'Moves money out.'],
  ['charge', 'Charges money.'],
  ['private_data', 'Touches private data.'],
  ['send_message', 'Sends a message out.'],
  ['change', 'Changes something.'],
  ['read', 'Changes nothing.'],
] as const satisfies readonly (readonly [Effect, string])[];

/** The effects that change something, so whether they can be undone is worth saying. */
const CHANGES = new Set<Effect>(['change', 'charge', 'pay_out', 'send_message']);

/**
 * A connected tool's line in the boards' words, from its profile's effects: the weightiest effect
 * ("Moves money out."), then " Can be undone." or " Can't be undone." when an effect changes
 * something. A tool that only reads, or reads private data, has no second sentence.
 */
export function describeEffects(effects: readonly Effect[], reversible: boolean): string {
  const first = EFFECT_LINES.find(([effect]) => effects.includes(effect));
  // A tool with no effect this build knows is never described as harmless: it changes something.
  if (first === undefined) return `Changes something. ${reversible ? 'Can be undone.' : "Can't be undone."}`;
  if (!effects.some((effect) => CHANGES.has(effect))) return first[1];
  return `${first[1]} ${reversible ? 'Can be undone.' : "Can't be undone."}`;
}
