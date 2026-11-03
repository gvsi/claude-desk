import type { CSSProperties } from 'react';

import type { Outcome } from '../../../api/contracts.ts';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';
import { RuleSentence, type SentencePart } from '../RuleSentence/RuleSentence.tsx';
import { OUTCOME_WORDS as RULE_OUTCOMES } from '../OutcomeMenu/outcomeWords.ts';

import './SituationRow.css';

/** Each outcome's dot. */
const OUTCOME_TONES = {
  allow: 'handled',
  hold: 'held',
  refuse: 'refused',
} as const satisfies Record<Outcome, StatusTone>;

/** Each outcome in the owner's words. A missing outcome is a compile error. */
const OUTCOME_WORDS = {
  allow: RULE_OUTCOMES.auto,
  hold: RULE_OUTCOMES.ask,
  refuse: RULE_OUTCOMES.never,
} as const satisfies Record<Outcome, string>;

export interface SituationRowProps {
  /** The situation, as the check describes it: "A visitor asks for 10% off if they pay cash". */
  title: string;
  /** Who is asking in it: "A visitor, not verified", "Alex Kim’s assistant, signed limit". */
  who: string;
  /** What the draft rules do in it: the probe's `outcome`. */
  outcome: Outcome;
  /** A reviewer-dependent hold belongs to an Allow rule. Reviewer details live in the rule's disclosure. */
  dependsOnReview: boolean;
  /** The kernel's `reason_plain`, as written. */
  reason: string;
  /** The covering rule's sentence, when setup can map the probe to one. Otherwise keep its reason. */
  sentence?: readonly SentencePart[];
  /** False when the outcome isn't the one the setup interview planned: "Not what we planned". */
  matches: boolean;
  /** The row's place in the list, from 0: a live row lands `motion-stagger` after the one before it. */
  index?: number;
  /**
   * The row came with results that just arrived: it lands `index` × `motion-stagger` after the
   * first, rising `space-4` as it fades in, its dot scaling in with it. Without it the row is drawn
   * still, as results the owner didn't just ask for are. The screen clears it once the rows have
   * landed, so nothing replays them.
   */
  live?: boolean;
}

/**
 * One real situation run against the draft rules in setup: what happens and who is asking at the
 * left; at the right the outcome in words beside its dot, and the kernel's reason under it. A row
 * whose outcome isn't the planned one says so under who is asking, beside a thin held bar. Live
 * rows land one by one, `motion-stagger` apart, and appear at once under reduced motion. The row is
 * drawn with hairlines only between rows; put each in a list item.
 */
export function SituationRow({ title, who, outcome, dependsOnReview, reason, sentence, matches, index = 0, live = false }: SituationRowProps) {
  const ruleOutcome = dependsOnReview ? 'allow' : outcome;
  const words = OUTCOME_WORDS[ruleOutcome];
  const tone = OUTCOME_TONES[ruleOutcome];
  const style = { '--cd-situation-row-index': Math.max(0, Math.floor(index)) } as CSSProperties;
  return (
    <div className={live ? 'cd-situation-row cd-situation-row--live' : 'cd-situation-row'} style={style}>
      <div className="cd-situation-row__grid">
        <div className="cd-situation-row__situation">
          <p className="cd-situation-row__title cd-type-control">{title}</p>
          <p className="cd-situation-row__who cd-type-meta">{who}</p>
          {matches ? null : <p className="cd-situation-row__flag cd-type-caption">Not what we planned</p>}
        </div>
        <div className="cd-situation-row__result">
          <p className="cd-situation-row__outcome cd-type-meta">
            <StatusDot tone={tone} />
            <span>{words}</span>
          </p>
          {sentence === undefined ? <p className="cd-situation-row__reason cd-type-meta">{reason}</p> :
            <div className="cd-situation-row__reason"><RuleSentence parts={sentence} /></div>}
        </div>
      </div>
    </div>
  );
}
