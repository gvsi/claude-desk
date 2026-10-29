import type { ReactNode } from 'react';

import { CheckpointMeter, type Checkpoint } from './CheckpointMeter.tsx';

import './AttemptRow.css';

export interface AttemptRowProps {
  /** When it happened, as the screen writes it: "9:52 am". */
  time: string;
  /** What they tried, in one line: "Asked for Raj Patel's invoice". Mark quoted words `data-copy="user"`. */
  title: ReactNode;
  /** Where it came from: "From chat", "From the chat service". */
  who: string;
  /** The checkpoint that stopped it. */
  stoppedBy: Checkpoint;
  /** The attempt's detail page. */
  href: string;
  /** The attempt open beside the list: marked `aria-current` on the selected fill. */
  current?: boolean;
}

/**
 * One stopped attempt in the Safety list: when, what they tried and where it came from, and the
 * checkpoint that stopped it (`CheckpointMeter`). The whole row is one link to the attempt's
 * detail. Put each in a list item.
 */
export function AttemptRow({ time, title, who, stoppedBy, href, current = false }: AttemptRowProps) {
  return (
    <a href={href} className="cd-attempt-row" aria-current={current || undefined}>
      <span className="cd-attempt-row__grid">
        <span className="cd-attempt-row__time cd-type-meta">{time}</span>
        <span className="cd-attempt-row__what">
          <span className="cd-attempt-row__title cd-type-control">{title}</span>
          <span className="cd-attempt-row__who cd-type-caption">{who}</span>
        </span>
        <span className="cd-attempt-row__stopped">
          <CheckpointMeter stoppedBy={stoppedBy} />
        </span>
      </span>
    </a>
  );
}
