import type { CSSProperties } from 'react';

import type { Outcome } from '../../../api/contracts.ts';
import { type Checkpoint } from '../AttemptRow/CheckpointMeter.tsx';
import { OUTCOME_WORDS } from '../OutcomeMenu/outcomeWords.ts';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './SafetyCheckRow.css';

/** Each verdict's badge; a trick that got through keeps the failing presentation. */
const OUTCOMES = {
  refuse: { label: OUTCOME_WORDS.never, tone: 'refused' },
  hold: { label: OUTCOME_WORDS.ask, tone: 'held' },
  allow: { label: 'Not blocked', tone: 'held' },
} as const satisfies Record<Outcome, { label: string; tone: StatusTone }>;

export interface SafetyCheckRowProps {
  /** The kind of trick, as Safety names it: "Posing as you", "Money", "Codes". */
  label: string;
  /** The words the check tried, as a visitor would type them. Shown in quotes, as their words. */
  attempt: string;
  /** The probe's verdict, which sets the badge independently of whether it passed the check. */
  outcome: Outcome;
  /** Whether the draft rules stopped it, as the API reports; the screen uses this for its count. */
  blocked: boolean;
  /** The checkpoint that stopped it, when it was stopped. */
  stoppedBy?: Checkpoint;
  /** The kernel's `reason_plain`, as written. */
  reason: string;
  /** The row's place in the list, from 0: a live row lands `motion-stagger` after the one before it. */
  index: number;
  /**
   * The row came with results that just arrived: it lands `index` × `motion-stagger` after the
   * first, rising `space-4` as it fades in, its dot scaling in with it. Without it the row is drawn
   * still, as results the owner didn't just ask for are. The screen clears it once the rows have
   * landed, so nothing replays them.
   */
  live?: boolean;
}

/**
 * One trick the setup safety check tried on the draft rules: what kind it is, the words it tried in
 * quotes at the left; at the right "Never", "Ask me first" or "Not blocked"
 * beside its dot, and the kernel's reason under it. Live rows land one by one, `motion-stagger`
 * apart, and appear at once under reduced motion. Hairlines are drawn only between rows; put
 * each in a list item.
 */
export function SafetyCheckRow({ label, attempt, outcome, reason, index, live = false }: SafetyCheckRowProps) {
  const style = { '--cd-safety-check-index': Math.max(0, Math.floor(index)) } as CSSProperties;
  const badge = OUTCOMES[outcome];
  return (
    <div className={live ? 'cd-safety-check-row cd-safety-check-row--live' : 'cd-safety-check-row'} style={style}>
      <div className="cd-safety-check-row__grid">
        <div className="cd-safety-check-row__trick">
          <p className="cd-safety-check-row__label cd-type-control">{label}</p>
          <p className="cd-safety-check-row__attempt cd-type-meta">
            “<span data-copy="user">{attempt}</span>”
          </p>
        </div>
        <div className="cd-safety-check-row__result">
          <p className="cd-safety-check-row__outcome cd-type-meta">
            <StatusDot tone={badge.tone} />
            <span>{badge.label}</span>
          </p>
          <p className="cd-safety-check-row__reason cd-type-meta">{reason}</p>
        </div>
      </div>
    </div>
  );
}
