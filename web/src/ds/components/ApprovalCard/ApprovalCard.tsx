import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { ApprovalAnswer, Decision, DecisionState } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Button, type ButtonVariant } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { receiptTone } from '../MarginReceipt/receiptTone.ts';
import { errorCopy } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './ApprovalCard.css';

/** Each answer's button, in the order the card offers them. A missing answer is a compile error. */
const ANSWER_LABELS = {
  allow_once: 'Allow this time',
  deny_once: 'Deny this time',
  allow_person: 'Allow only for this person',
  deny_always: 'Deny always',
} as const satisfies Record<ApprovalAnswer, string>;

const ANSWER_ORDER = Object.keys(ANSWER_LABELS) as readonly ApprovalAnswer[];

/**
 * Each answer's weight: Allow this time stays neutral, Deny this time is the soft red fill, and the
 * answers that save a rule are quieter, Allow only for this person neutral and Deny always in red words.
 */
const ANSWER_VARIANTS = {
  allow_once: 'secondary',
  deny_once: 'danger',
  allow_person: 'ghost',
  deny_always: 'danger-ghost',
} as const satisfies Record<ApprovalAnswer, ButtonVariant>;

/** The answers that also draft a rule, which the owner sees before it applies. */
const SAVES_A_RULE = {
  allow_once: false,
  deny_once: false,
  allow_person: true,
  deny_always: true,
} as const satisfies Record<ApprovalAnswer, boolean>;

/** An answer that also saves a rule. */
type RuleAnswer = { [A in ApprovalAnswer]: (typeof SAVES_A_RULE)[A] extends true ? A : never }[ApprovalAnswer];

/** The line under the answers, for the rule answers offered: one of them, or both. */
const RULE_LINES = {
  allow_person:
    "Allow only for this person also saves a rule, so Claude allows requests like this from this person on its own. You'll see the rule before it applies.",
  deny_always: "Deny always also saves a rule, so Claude declines requests like this on its own. You'll see the rule before it applies.",
  both: "Allow only for this person and Deny always also save a rule, so Claude handles requests like this on its own. You'll see the rule before it applies.",
} as const satisfies Record<RuleAnswer | 'both', string>;

/** The label before the rule answers when they have a row of their own. */
const RULE_ROW_LABEL = 'Or save a rule:';

/** The card's status line in each state: waiting while held, then the final line. */
const STATUS_LINES = {
  held: 'Waiting for your answer',
  approved: 'You allowed this.',
  executed: "You allowed this. It's done.",
  failed: "You allowed this, but it didn't go through. Nothing was done.",
  unknown: 'You allowed this. Still confirming whether it went through.',
  refused_at_execution: "Your rules changed before this ran, so it wasn't done.",
  denied: 'You denied this.',
  expired: 'This request expired before you answered. Nothing was done.',
  cancelled: 'The visitor cancelled before you answered. Nothing was done.',
  allowed: 'Your rules allowed this.',
  refused: 'Your rules refused this.',
} as const satisfies Record<DecisionState, string>;

const SENDING_LINE = 'Sending your answer';
const ERROR_LINE = "We couldn't confirm your answer. Try again, or reload to see where it stands.";

export interface ApprovalCardProps {
  /** The held request, as the kernel returned it. Its `state` and `answers` decide what the card offers. */
  decision: Decision;
  /** The rule that held it (`NeedsYouItem.held_by`), shown as "Held by your rule: {heldBy}", in the owner's words. */
  heldBy?: string;
  /** One line of context in meta type; mark a visitor's own words with `data-copy="user"`. */
  context?: ReactNode;
  /** Where and when it was held: "Web chat, 2 min ago". */
  waiting: string;
  /**
   * Called once per click with the answer; the card waits for the result. Return the request's
   * promise, and a rejection lets the owner answer again even if `pending` and `error` stay the same.
   */
  onAnswer: (answer: ApprovalAnswer) => void | Promise<unknown>;
  /** The answer is being sent: "Sending your answer", with every answer waiting. */
  pending?: boolean;
  /** The answer may not have gone through: `true` shows the card's line, a string the screen's own. */
  error?: boolean | string;
}

/** The click that is waiting for its result, and the screen's `pending` and `error` it last saw. */
interface AnswerLock {
  /** Which click this is, so a late rejection releases only its own lock. */
  click: number;
  key: string;
  pending: boolean;
  error: boolean | string | undefined;
}

/** The answers the kernel offers for this decision, in the card's order; none unless it is held. */
function offeredAnswers(decision: Decision): ApprovalAnswer[] {
  if (decision.state !== 'held') return [];
  return ANSWER_ORDER.filter((answer) => decision.answers?.includes(answer) === true);
}

/** True for an answer that also saves a rule. */
function savesARule(answer: ApprovalAnswer): answer is RuleAnswer {
  return SAVES_A_RULE[answer];
}

/** The line under the answers for the rule answers offered, or null when none is. */
function ruleLine(saving: readonly RuleAnswer[]): string | null {
  const [first, ...more] = saving;
  if (first === undefined) return null;
  return more.length > 0 ? RULE_LINES.both : RULE_LINES[first];
}

/** The status line for `state`; a state this build doesn't know asks for a reload, and offers nothing. */
function statusLine(state: DecisionState): string {
  return Object.hasOwn(STATUS_LINES, state) ? STATUS_LINES[state] : errorCopy('conflict');
}

/**
 * A request the owner's rules held: what was asked, the rule that held it, and only the answers
 * the kernel offers while it is held. After an answer or an event, the final line takes the place
 * of "Waiting for your answer" with its receipt dot, and the answers go.
 */
export function ApprovalCard({ decision, heldBy, context, waiting, onAnswer, pending = false, error }: ApprovalCardProps) {
  const offered = offeredAnswers(decision);
  const showAnswers = offered.length > 0;
  const failed = error === true || (typeof error === 'string' && error !== '');
  const answerKey = `${decision.decision_id}\n${decision.state}`;

  // One click waits until the decision or its state changes, the screen says that answer ended in
  // an error (`error` on and `pending` off, after either of them changed since the click), or the
  // promise `onAnswer` returned rejects.
  const [lock, setLock] = useState<AnswerLock | null>(null);
  const clicks = useRef(0);
  let locked = false;
  if (lock !== null) {
    if (lock.key !== answerKey) {
      setLock(null);
    } else if (lock.pending === pending && lock.error === error) {
      locked = true;
    } else if (failed && !pending) {
      setLock(null);
    } else {
      locked = true;
      setLock({ ...lock, pending, error });
    }
  }
  const waitingForResult = pending || locked;

  // When the answers go while one of them had focus, focus moves to the status line, so a
  // keyboard user isn't dropped to the top of the page.
  const statusRef = useRef<HTMLSpanElement>(null);
  const answeredHere = useRef(false);
  useLayoutEffect(() => {
    if (showAnswers || !answeredHere.current) return;
    answeredHere.current = false;
    const status = statusRef.current;
    const active = status?.ownerDocument.activeElement;
    if (status && (active == null || active === status.ownerDocument.body)) status.focus();
  }, [showAnswers]);

  const answer = (value: ApprovalAnswer) => {
    if (waitingForResult) return;
    answeredHere.current = true;
    clicks.current += 1;
    const click = clicks.current;
    setLock({ click, key: answerKey, pending, error });
    const sent = onAnswer(value);
    if (sent !== undefined && typeof sent.then === 'function') {
      sent.then(undefined, () => setLock((current) => (current !== null && current.click === click ? null : current)));
    }
  };

  const once = offered.filter((value) => !savesARule(value));
  const saving = offered.filter(savesARule);
  const note = ruleLine(saving);
  // Two rule answers take a labelled row of their own under the one-time answers; a single one
  // follows them on the same row, after a thin divider.
  const ruleRow = saving.length > 1;
  const ruleRowLabel = useId();
  const answerButton = (value: ApprovalAnswer) => (
    <Button key={value} variant={ANSWER_VARIANTS[value]} size="main" busy={waitingForResult} onClick={() => answer(value)}>
      {ANSWER_LABELS[value]}
    </Button>
  );

  return (
    <Card as="article" label={`Held for you: ${decision.reason_plain}`}>
      <div className="cd-approval-card__top cd-type-caption">
        <span className="cd-approval-card__status">
          <StatusDot tone={receiptTone({ kind: 'decision', state: decision.state })} />
          <span ref={statusRef} role="status" tabIndex={-1} className="cd-approval-card__status-line">
            {statusLine(decision.state)}
          </span>
        </span>
        <span className="cd-approval-card__waiting">{waiting}</span>
      </div>
      <p className="cd-approval-card__reason cd-type-summary">{decision.reason_plain}</p>
      {context ? <p className="cd-approval-card__context cd-type-meta">{context}</p> : null}
      {heldBy ? (
        <p className="cd-approval-card__held-by cd-type-meta">
          <Icon name="rules" size={16} className="cd-approval-card__held-by-icon" />
          <span>
            Held by your rule:{' '}
            <span className="cd-approval-card__rule" data-copy="user">
              {heldBy}
            </span>
          </span>
        </p>
      ) : null}
      {showAnswers ? (
        <>
          <div role="group" aria-label="Your answer" aria-busy={waitingForResult || undefined} className="cd-approval-card__answers">
            <div className="cd-approval-card__rows">
              {ruleRow ? (
                <>
                  {once.length > 0 ? <div className="cd-approval-card__row">{once.map(answerButton)}</div> : null}
                  <div role="group" aria-labelledby={ruleRowLabel} className="cd-approval-card__row">
                    <span id={ruleRowLabel} className="cd-approval-card__row-label cd-type-caption">
                      {RULE_ROW_LABEL}
                    </span>
                    {saving.map(answerButton)}
                  </div>
                </>
              ) : (
                <div className="cd-approval-card__row">
                  {once.map(answerButton)}
                  {once.length > 0 && saving.length > 0 ? <span aria-hidden="true" className="cd-approval-card__divider" /> : null}
                  {saving.map(answerButton)}
                </div>
              )}
            </div>
          </div>
          {note ? <p className="cd-approval-card__note cd-type-caption">{note}</p> : null}
          <p role="status" className="cd-approval-card__progress cd-type-caption">
            {pending ? SENDING_LINE : null}
          </p>
          {failed && !pending ? (
            <div className="cd-approval-card__error">
              <Notice tone="error">{error === true ? ERROR_LINE : error}</Notice>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
