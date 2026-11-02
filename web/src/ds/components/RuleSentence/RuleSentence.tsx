import type { RuleTarget } from '../ChangeReview/ChangeReview.tsx';
import { OUTCOME_TONE, OUTCOME_WORDS, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import { ToolTitleList } from '../RuleRow/ToolTitles.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';

import './RuleSentence.css';

/**
 * One run of a rule's sentence, in the screen's words (`ruleSentence`): plain text; a `key` value
 * set off ("$300", "weekdays, 8:00 am to 6:00 pm", "list price"); or a `user` run, a tool's own
 * title inside the sentence ("emergency callback"), shown as user text. The design system words
 * and formats none of them.
 */
export interface SentencePart {
  text: string;
  key?: boolean;
  user?: boolean;
}

/**
 * The line under a rule's sentence: the tools it covers, by their titles (`{ titles }`, each the
 * tool's own words, set off as user text and joined "Payment link, Charge within a signed limit
 * and Refund") or the screen's own words for a group of tools ("Every tool"); then who it is for
 * ("Anyone", "The customer, once verified").
 */
export interface RuleMeta {
  tools: RuleTarget;
  who: string;
}

export interface RuleSentenceProps {
  /** The sentence, led by Claude: "Claude can send payment links up to **$300**". */
  parts: readonly SentencePart[];
  /** The tools it covers and who, on the line under it. Without it, the sentence stands alone. */
  meta?: RuleMeta;
  /** The rule's outcome at the right, its dot and its word; under the sentence when the row is narrow. */
  outcome?: RuleMode;
  /** A side of a change: the rule as it was (`before`, a refused-tone line at its left) or will be (`after`, handled). */
  changed?: 'before' | 'after';
}

/** One run of the sentence: a key value in `<strong>`, a tool's title as user text, else plain text. */
function Part({ part }: { part: SentencePart }) {
  if (part.user === true) {
    const className = part.key === true ? 'cd-rule-sentence__user cd-rule-sentence__key' : 'cd-rule-sentence__user';
    return (
      <span className={className} data-copy="user">
        {part.text}
      </span>
    );
  }
  if (part.key === true) return <strong className="cd-rule-sentence__key">{part.text}</strong>;
  return <>{part.text}</>;
}

/**
 * A rule as one sentence led by Claude, with its key values set off in the interface font's medium
 * weight and tabular figures; under it the tools it covers and who; and its outcome at the right,
 * or under the sentence when the row is under 480 px wide (a phone).
 */
export function RuleSentence({ parts, meta, outcome, changed }: RuleSentenceProps) {
  const className = changed === undefined ? 'cd-rule-sentence' : `cd-rule-sentence cd-rule-sentence--${changed}`;
  return (
    <div className={className}>
      <div className="cd-rule-sentence__layout">
        <div className="cd-rule-sentence__text">
          <p className="cd-rule-sentence__sentence cd-type-body">
            {parts.map((part, index) => (
              <Part key={index} part={part} />
            ))}
          </p>
          {meta === undefined ? null : (
            <p className="cd-rule-sentence__meta cd-type-meta">
              {typeof meta.tools === 'string' ? <span className="cd-rule-sentence__group">{meta.tools}</span> : <ToolTitleList titles={meta.tools.titles} />}
              {meta.who.trim() === '' ? null : ` · ${meta.who}`}
            </p>
          )}
        </div>
        {outcome === undefined ? null : (
          <span className="cd-rule-sentence__outcome cd-type-meta">
            <StatusLabel tone={OUTCOME_TONE[outcome]}>{OUTCOME_WORDS[outcome]}</StatusLabel>
          </span>
        )}
      </div>
    </div>
  );
}
