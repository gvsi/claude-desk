import type { ReactNode } from 'react';

import { RecordedTag } from '../RecordedTag/RecordedTag.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import { CheckpointMeter, type Checkpoint } from './CheckpointMeter.tsx';

import './AttemptRow.css';

export interface AttemptRowProps {
  /** When it happened, as the screen writes it: "9:52 am". */
  time: string;
  /**
   * Why a refused request was turned down, in a few words: "Your rule says no". A refused
   * `StatusLabel` over what they tried. Leave it out when there is no reason to give.
   */
  why?: string;
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
  /** Recorded history replayed into this copy: the Recorded tag after where it came from. */
  recorded?: boolean;
}

/**
 * One stopped attempt in the Safety list: when, why it was turned down when there is a reason to
 * give, what they tried and where it came from (with the Recorded tag after it when the attempt
 * was replayed), and the checkpoint that stopped it (`CheckpointMeter`). The whole row is one link
 * to the attempt's detail. Put each in a list item.
 */
export function AttemptRow({ time, why, title, who, stoppedBy, href, current = false, recorded = false }: AttemptRowProps) {
  return (
    <a href={href} className="cd-attempt-row" aria-current={current || undefined}>
      <span className="cd-attempt-row__grid">
        <span className="cd-attempt-row__time cd-type-meta">{time}</span>
        <span className="cd-attempt-row__what">
          {why ? (
            <span className="cd-attempt-row__why cd-type-meta">
              <StatusLabel tone="refused">{why}</StatusLabel>
            </span>
          ) : null}
          <span className="cd-attempt-row__title cd-type-control">{title}</span>
          <span className="cd-attempt-row__from">
            <span className="cd-attempt-row__who cd-type-caption">{who}</span>
            {recorded ? <RecordedTag /> : null}
          </span>
        </span>
        <span className="cd-attempt-row__stopped">
          <CheckpointMeter stoppedBy={stoppedBy} />
        </span>
      </span>
    </a>
  );
}
