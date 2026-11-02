import type { Effect } from '../../../api/contracts.ts';
import { Pill } from '../Pill/Pill.tsx';

import './EffectTags.css';

/** The weightiest effect worth a tag, first match wins: money before private data. */
const EFFECT_TAGS = [
  ['pay_out', 'Money'],
  ['charge', 'Money'],
  ['private_data', 'Private data'],
] as const satisfies readonly (readonly [Effect, string])[];

/** The effects that change something, so whether they can be undone is worth a tag. */
const CHANGES: ReadonlySet<Effect> = new Set<Effect>(['change', 'charge', 'pay_out', 'send_message']);

/** The effects this build knows: a tool with none of them is never shown as harmless. */
const KNOWN: ReadonlySet<Effect> = new Set<Effect>(['read', 'change', 'charge', 'pay_out', 'send_message', 'private_data']);

/**
 * A tool's tags, in the boards' words: its weightiest effect, "Money" (it charges or pays out) or
 * else "Private data"; then "Can't be undone" when it changes something and can't be undone (as
 * does a tool with no effect this build knows). A tool that only reads, or can be undone, has none
 * for that. They replace the effect sentences ("Changes something. Can be undone.").
 */
export function effectTags(effects: readonly Effect[], reversible: boolean): string[] {
  const tags: string[] = [];
  const weightiest = EFFECT_TAGS.find(([effect]) => effects.includes(effect));
  if (weightiest !== undefined) tags.push(weightiest[1]);
  const changes = effects.some((effect) => CHANGES.has(effect)) || !effects.some((effect) => KNOWN.has(effect));
  if (changes && !reversible) tags.push("Can't be undone");
  return tags;
}

export interface EffectTagsProps {
  /** The tool's effects, from its profile. */
  effects: readonly Effect[];
  /** Whether what it does can be undone. */
  reversible: boolean;
}

/**
 * A tool's small fixed tags ("Money", "Can't be undone", "Private data"), each a `Pill`, as C4
 * draws them after a tool's title: 8 px after it, 4 px between them. A tool with no tag draws nothing.
 */
export function EffectTags({ effects, reversible }: EffectTagsProps) {
  const tags = effectTags(effects, reversible);
  if (tags.length === 0) return null;
  return (
    <span className="cd-effect-tags">
      {tags.map((tag) => (
        <Pill key={tag}>{tag}</Pill>
      ))}
    </span>
  );
}
