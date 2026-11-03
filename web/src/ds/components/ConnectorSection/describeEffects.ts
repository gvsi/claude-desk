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

/** Every effect this build has words for. */
const KNOWN = new Set<string>(EFFECT_LINES.map(([effect]) => effect));

/**
 * A tool's effects as a list, in the same words without their stops, for its details (REV-RULES-D:
 * "Charges money · Can't be undone"): every effect it has, weightiest first, then whether it can be
 * undone when an effect changes something. Reading alone is "Changes nothing"; beside another effect
 * it isn't said, since something does change. An effect this build doesn't know reads as a change,
 * "Changes something", said beside the known ones (once), never dropped because one of them is known.
 */
export function effectPhrases(effects: readonly Effect[], reversible: boolean): string[] {
  const unknown = effects.length === 0 || effects.some((effect) => !KNOWN.has(effect));
  const known = EFFECT_LINES.filter(([effect]) => effects.includes(effect) && (effect !== 'read' || effects.length === 1));
  const words = known.map(([, line]) => line.slice(0, -1));
  if (unknown && !words.includes('Changes something')) words.push('Changes something');
  const changes = unknown || effects.some((effect) => CHANGES.has(effect));
  return changes ? [...words, reversible ? 'Can be undone' : "Can't be undone"] : words;
}
