/**
 * The held card's "Your rule" box as shapes, for the skeletons that draw a fresh copy's held request
 * (Today's and a conversation's): its label, the rule's sentence and its line, each as many lines as
 * its words take, and its outcome, laid out by the real box's classes, so the outcome sits at the
 * right or under the line as the card's width says. The words are the fresh copy's (Decision 15),
 * measured only and never put on the page.
 */
import { useRef } from 'react';

import { rivera } from '../../ds/fixtures/index.ts';
import { Skeleton, type SkeletonText } from '../../ds/index.ts';
import { listWords } from '../../lib/format.ts';
import { useTextLines } from '../../lib/useTextLines.ts';
import { NO_BUSINESS_TOOLS } from '../connectors/catalog.ts';
import { heldRule } from '../rules/requestRule.ts';
import type { RuleMeta } from '../rules/ruleSentence.ts';

/** The meta line's words, as `RuleSentence` writes them: the tools, then " · " and who. */
function metaWords(meta: RuleMeta): string {
  const tools = typeof meta.tools === 'string' ? meta.tools : listWords(meta.tools.titles);
  return `${tools} · ${meta.who}`;
}

/** The fresh copy's held quote's rule: 15% off past the list-price quote rule. */
const FRESH_RULE = heldRule({ decision: rivera.decisions.held, held_by: null }, Object.values(rivera.ruleCards), { business: NO_BUSINESS_TOOLS });
const SENTENCE = FRESH_RULE?.parts.map((part) => part.text).join('') ?? '';
const META = FRESH_RULE === null ? '' : metaWords(FRESH_RULE.meta);

function Lines({ words, className, text, lastWidth }: { words: string; className: string; text: SkeletonText; lastWidth: string }) {
  const box = useRef<HTMLDivElement>(null);
  const count = useTextLines(box, { parts: [words], className: `${className} cd-type-${text}` }, 1);
  return (
    <div ref={box} className={className}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === count - 1 ? lastWidth : '100%'} />
      ))}
    </div>
  );
}

/** The box's shapes, or nothing when the fresh copy's hold names no rule. */
export function HeldRuleShape() {
  if (FRESH_RULE === null) return null;
  return (
    <div className="cd-approval-card__rule" data-skeleton-part="held-rule">
      <div className="cd-approval-card__rule-label">
        <Skeleton shape="line" text="caption" width={56} />
      </div>
      <div className="cd-rule-sentence">
        <div className="cd-rule-sentence__layout">
          <div className="cd-rule-sentence__text">
            <Lines words={SENTENCE} className="cd-rule-sentence__sentence" text="body" lastWidth="70%" />
            <Lines words={META} className="cd-rule-sentence__meta" text="meta" lastWidth="40%" />
          </div>
          {/* The outcome as `RuleSentence` draws it: a dot and its word in an inline status label, whose
              baseline (the dot's foot) sets the line's height when the outcome takes its own line on a phone. */}
          <span className="cd-rule-sentence__outcome cd-type-meta">
            <span className="cd-status-label">
              <Skeleton shape="circle" size={6} />
              <Skeleton shape="line" text="meta" width={70} />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
