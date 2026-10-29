import type { RuleCard } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { OutcomeMenu } from '../OutcomeMenu/OutcomeMenu.tsx';
import type { RuleMode } from '../OutcomeMenu/outcomeWords.ts';

import './RuleRow.css';

/**
 * One part of what a card enforces, in the screen's words (Plan 04's `ruleWords(card, people)`):
 * who it is for ("Anyone"), its limits ("Up to $300"), its hours, or its review gate ("Checked by
 * the reviewer"). The design system formats none of them.
 */
export interface RuleWord {
  field: 'who' | 'limits' | 'hours' | 'review';
  text: string;
}

export interface RuleRowProps {
  rule: Pick<RuleCard, 'card_id' | 'mode' | 'reason'>;
  /** What the card enforces, shown under its reason, joined by " · ". */
  words: readonly RuleWord[];
  /** The screen's formatted amount for an auto card with `max_amount_cents` ("$300"). */
  limit?: string;
  /**
   * A rule on an effect group (`effect:charge`), shown under every tool it governs: `appliesTo` is
   * the screen's words for what it covers. Changing it from any of those tools changes the one rule.
   */
  shared?: { appliesTo: string };
  /** Makes the outcome a menu; the pick goes to the screen, which shows the drafted change first. */
  onChangeOutcome?: (mode: RuleMode) => void;
}

/**
 * One rule: its reason, the words for what it enforces, a line for a shared rule, and its outcome
 * at the right.
 */
export function RuleRow({ rule, words, limit, shared, onChangeOutcome }: RuleRowProps) {
  const line = words
    .map((word) => word.text.trim())
    .filter((text) => text !== '')
    .join(' · ');
  return (
    <div className="cd-rule-row">
      <div className="cd-rule-row__text">
        <p className="cd-rule-row__reason cd-type-body">{rule.reason}</p>
        {line !== '' ? <p className="cd-rule-row__words cd-type-meta">{line}</p> : null}
        {shared ? (
          <p className="cd-rule-row__shared cd-type-caption">
            <Icon name="shared" size={14} />
            <span>Shared rule. {shared.appliesTo}</span>
          </p>
        ) : null}
      </div>
      <OutcomeMenu label={rule.reason} value={rule.mode} limit={limit} onChange={onChangeOutcome} />
    </div>
  );
}
