import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { ApprovalAnswer, Decision, DecisionState } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
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

/** The answers that also draft a rule, which the owner sees before it applies. */
const SAVES_A_RULE = {
  allow_once: false,
  deny_once: false,
  allow_person: true,
  deny_always: true,
} as const satisfies Record<ApprovalAnswer, boolean>;

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
  /** Called once per click with the answer; the card waits for the result. */
  onAnswer: (answer: ApprovalAnswer) => void;
  /** The answer is being sent: "Sending your answer", with every answer waiting. */
  pending?: boolean;
  /** The answer may not have gone through: `true` shows the card's line, a string the screen's own. */
  error?: boolean | string;
}

/** The click that is waiting for its result, and the screen's `pending` and `error` it last saw. */
interface AnswerLock {
  key: string;
  pending: boolean;
  error: boolean | string | undefined;
}

/** The answers the kernel offers for this decision, in the card's order; none unless it is held. */
function offeredAnswers(decision: Decision): ApprovalAnswer[] {
  if (decision.state !== 'held') return [];
  return ANSWER_ORDER.filter((answer) => decision.answers?.includes(answer) === true);
}

/** The line under the answers that names the offered answers that also save a rule, or null. */
function ruleLine(offered: readonly ApprovalAnswer[]): string | null {
  const saving = offered.filter((answer) => SAVES_A_RULE[answer]).map((answer) => ANSWER_LABELS[answer]);
  if (saving.length === 0) return null;
  const verb = saving.length === 1 ? 'saves' : 'save';
  return `${saving.join(' and ')} also ${verb} a rule. You'll see it before it applies.`;
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

  // One click waits until the decision or its state changes, or the screen says that answer ended
  // in an error (`error` on and `pending` off, after either of them changed since the click).
  const [lock, setLock] = useState<AnswerLock | null>(null);
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
      setLock({ key: lock.key, pending, error });
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
    setLock({ key: answerKey, pending, error });
    onAnswer(value);
  };

  const note = ruleLine(offered);
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
            {offered.map((value) => (
              <Button key={value} variant="secondary" size="main" busy={waitingForResult} onClick={() => answer(value)}>
                {ANSWER_LABELS[value]}
              </Button>
            ))}
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
