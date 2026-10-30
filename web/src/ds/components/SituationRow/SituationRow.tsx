import type { Outcome } from '../../../api/contracts.ts';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './SituationRow.css';

/** Each outcome's dot. */
const OUTCOME_TONES = {
  allow: 'handled',
  hold: 'held',
  refuse: 'refused',
} as const satisfies Record<Outcome, StatusTone>;

/** Each outcome in the owner's words. A missing outcome is a compile error. */
const OUTCOME_WORDS = {
  allow: 'Does it',
  hold: 'Asks you',
  refuse: 'Never',
} as const satisfies Record<Outcome, string>;

/** An automatic outcome that holds only when Claude's second look agrees. */
const SECOND_LOOK = 'Does it if Claude’s second look agrees';

export interface SituationRowProps {
  /** The situation, as the check describes it: "A visitor asks for 10% off if they pay cash". */
  title: string;
  /** Who is asking in it: "A visitor, not verified", "Alex Kim’s assistant, signed limit". */
  who: string;
  /** What the draft rules do in it: the probe's `outcome`. */
  outcome: Outcome;
  /** The probe's `depends_on_review`: an automatic outcome that needs Claude's second look to agree. */
  dependsOnReview: boolean;
  /** The kernel's `reason_plain`, as written. */
  reason: string;
  /** False when the outcome isn't the one the setup interview planned: "Not what we planned". */
  matches: boolean;
}

/**
 * One real situation run against the draft rules in setup: what happens and who is asking at the
 * left; at the right the outcome in words beside its dot, and the kernel's reason under it. A row
 * whose outcome isn't the planned one says so under who is asking, beside a thin held bar. The row
 * is drawn with a hairline over it; put each in a list item.
 */
export function SituationRow({ title, who, outcome, dependsOnReview, reason, matches }: SituationRowProps) {
  const words = outcome === 'allow' && dependsOnReview ? SECOND_LOOK : OUTCOME_WORDS[outcome];
  return (
    <div className="cd-situation-row">
      <div className="cd-situation-row__grid">
        <div className="cd-situation-row__situation">
          <p className="cd-situation-row__title cd-type-control">{title}</p>
          <p className="cd-situation-row__who cd-type-meta">{who}</p>
          {matches ? null : <p className="cd-situation-row__flag cd-type-caption">Not what we planned</p>}
        </div>
        <div className="cd-situation-row__result">
          <p className="cd-situation-row__outcome cd-type-meta">
            <StatusDot tone={OUTCOME_TONES[outcome]} />
            <span>{words}</span>
          </p>
          <p className="cd-situation-row__reason cd-type-meta">{reason}</p>
        </div>
      </div>
    </div>
  );
}
