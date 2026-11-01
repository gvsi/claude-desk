import { useId } from 'react';

import { Icon } from '../../icons/index.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';

import './AlwaysOnList.css';

/**
 * The always-on baseline, in the owner's words: enforced on every Desk, whatever is connected.
 * Exported so a skeleton can measure the lines they take, without drawing them.
 */
export const ALWAYS_ON = [
  "Always says it's an AI",
  'Private data only to its verified owner',
  'Codes only go to the contact on record',
  'No money moves without your rule or a signed limit',
  'Every attempt is logged and shown to you',
] as const;

export interface AlwaysOnListProps {
  /** The heading's level: `2` (the default) on the Rules page, `3` under another section. */
  level?: 2 | 3;
}

/**
 * The always-on rules: "Always on", a caption that says they can't be turned off, and each rule
 * beside a lock. There are no controls: nothing here can be changed.
 */
export function AlwaysOnList({ level = 2 }: AlwaysOnListProps) {
  const headingId = useId();
  return (
    <section className="cd-always-on" aria-labelledby={headingId}>
      <SectionHeader
        id={headingId}
        level={level}
        title="Always on"
        caption="On every Desk, whatever is connected. They can't be turned off."
      />
      <ul role="list" className="cd-always-on__list">
        {ALWAYS_ON.map((line) => (
          <li key={line} className="cd-always-on__item cd-type-body">
            <Icon name="lock" size={14} className="cd-always-on__lock" />
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}
