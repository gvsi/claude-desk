import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { ApprovalAnswer, Decision, DecisionState } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Button, type ButtonVariant } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { receiptTone } from '../MarginReceipt/receiptTone.ts';
import { errorCopy } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './ApprovalCard.css';

/** The two controls of an answer, in the card's order. */
type Side = 'allow' | 'deny';

const SIDE_ORDER = ['allow', 'deny'] as const satisfies readonly Side[];

/** Each side's control: its word when it opens a menu, and its look. Allow is neutral, Deny the soft red fill. */
const SIDES = {
  allow: { word: 'Allow', variant: 'secondary' },
  deny: { word: 'Deny', variant: 'danger' },
} as const satisfies Record<Side, { word: string; variant: ButtonVariant }>;

const ONCE_LINE = 'Only this request. Nothing is saved.';
const RULE_LINE = "Saves a rule. You'll see it first.";

/**
 * Each answer's side and words, in the order a side offers them: the one-time answer, then the
 * one that also saves a rule. `button` is its plain button when it is its side's only answer;
 * `item` and `line` are its menu item. Allow only for this person's words are the generic ones;
 * with the person's name, `buttonWords` and `itemWords` put it in place of "this person". A missing
 * answer is a compile error.
 */
const ANSWERS = {
  allow_once: { side: 'allow', button: 'Allow this time', item: 'This time', line: ONCE_LINE },
  allow_person: { side: 'allow', button: 'Allow only for this person, always', item: 'Only for this person, always', line: RULE_LINE },
  deny_once: { side: 'deny', button: 'Deny this time', item: 'This time', line: ONCE_LINE },
  deny_always: { side: 'deny', button: 'Deny always', item: 'Always', line: RULE_LINE },
} as const satisfies Record<ApprovalAnswer, { side: Side; button: string; item: string; line: string }>;

const ANSWER_ORDER = Object.keys(ANSWERS) as readonly ApprovalAnswer[];

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
   * The verified person's name on record (`NeedsYouItem.session.display_name` when `verified`), so
   * Allow's rule answer reads "Only for {personName}, always". Leave it out for an agent or anyone
   * unverified: it reads "Only for this person, always".
   */
  personName?: string;
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

/** The menu that is open, and where focus lands in it, for the answers it was opened on. */
interface OpenMenu {
  side: Side;
  focus: 'first' | 'last';
  key: string;
}

/** The answers the kernel offers for this decision, in the card's order; none unless it is held. */
function offeredAnswers(decision: Decision): ApprovalAnswer[] {
  if (decision.state !== 'held') return [];
  return ANSWER_ORDER.filter((answer) => decision.answers?.includes(answer) === true);
}

/** The person's name as user text, or the generic words. */
function personWords(personName: string | undefined): ReactNode {
  if (personName === undefined || personName.trim() === '') return 'this person';
  return (
    <span className="cd-user-name" data-copy="user">
      {personName}
    </span>
  );
}

/** An answer's words on a plain button. */
function buttonWords(answer: ApprovalAnswer, personName: string | undefined): ReactNode {
  if (answer !== 'allow_person') return ANSWERS[answer].button;
  return <>Allow only for {personWords(personName)}, always</>;
}

/** An answer's words as a menu item. */
function itemWords(answer: ApprovalAnswer, personName: string | undefined): ReactNode {
  if (answer !== 'allow_person') return ANSWERS[answer].item;
  return <>Only for {personWords(personName)}, always</>;
}

/** The status line for `state`; a state this build doesn't know asks for a reload, and offers nothing. */
function statusLine(state: DecisionState): string {
  return Object.hasOwn(STATUS_LINES, state) ? STATUS_LINES[state] : errorCopy('conflict');
}

/**
 * A request the owner's rules held: what was asked, the rule that held it, and only the answers
 * the kernel offers while it is held, as two controls, Allow and Deny. A side with one answer is a
 * plain button; a side with two opens a menu of them. After an answer or an event, the final line
 * takes the place of "Waiting for your answer" with its receipt dot, and the answers go.
 */
export function ApprovalCard({ decision, heldBy, context, waiting, personName, onAnswer, pending = false, error }: ApprovalCardProps) {
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

  // One menu at a time, and none while an answer is sent or once the answers have changed.
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const menuSide = open !== null && open.key === answerKey && !waitingForResult ? open.side : null;
  const ids = useId();
  const buttonId = (side: Side) => `${ids}-${side}`;
  const answersRef = useRef<HTMLDivElement>(null);
  const focusButton = (side: Side) => {
    answersRef.current?.ownerDocument.getElementById(buttonId(side))?.focus();
  };
  const closeMenu = (returnFocus: boolean) => {
    if (returnFocus && open !== null) focusButton(open.side);
    setOpen(null);
  };

  // If an answer starts to be sent while a menu is open, the menu goes and focus waits on its button.
  useLayoutEffect(() => {
    if (!waitingForResult || open === null) return;
    const doc = answersRef.current?.ownerDocument;
    const menu = doc?.getElementById(`${buttonId(open.side)}-menu`);
    if (menu?.contains(doc?.activeElement ?? null)) focusButton(open.side);
    setOpen(null);
  });

  // A click on an open menu's button closes it, with focus on the button, whichever browser it is.
  const toggleMenu = (side: Side) => {
    if (menuSide === side) closeMenu(true);
    else setOpen({ side, focus: 'first', key: answerKey });
  };
  const onMenuButtonKey = (side: Side, event: KeyboardEvent<HTMLButtonElement>) => {
    if (waitingForResult) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen({ side, focus: event.key === 'ArrowDown' ? 'first' : 'last', key: answerKey });
  };
  const choose = (side: Side, value: ApprovalAnswer) => {
    // Focus goes back to the menu's button, and waits there while the answer is sent.
    focusButton(side);
    setOpen(null);
    answer(value);
  };

  const sides = SIDE_ORDER.map((side) => ({ side, answers: offered.filter((value) => ANSWERS[value].side === side) })).filter(
    ({ answers }) => answers.length > 0,
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
          <div
            ref={answersRef}
            role="group"
            aria-label="Your answer"
            aria-busy={waitingForResult || undefined}
            className="cd-approval-card__answers"
          >
            <div className="cd-approval-card__row">
              {sides.map(({ side, answers }) => {
                const [only] = answers;
                if (answers.length === 1 && only !== undefined) {
                  return (
                    <Button key={side} variant={SIDES[side].variant} size="main" busy={waitingForResult} onClick={() => answer(only)}>
                      {buttonWords(only, personName)}
                    </Button>
                  );
                }
                const isOpen = menuSide === side;
                return (
                  <div key={side} className="cd-approval-card__side">
                    <Button
                      id={buttonId(side)}
                      variant={SIDES[side].variant}
                      size="main"
                      busy={waitingForResult}
                      menuOpen={isOpen}
                      onClick={() => toggleMenu(side)}
                      onKeyDown={(event) => onMenuButtonKey(side, event)}
                    >
                      {SIDES[side].word}
                    </Button>
                    {isOpen && open !== null ? (
                      <AnswerMenu
                        id={`${buttonId(side)}-menu`}
                        side={side}
                        labelledBy={buttonId(side)}
                        answers={answers}
                        personName={personName}
                        focus={open.focus}
                        onChoose={(value) => choose(side, value)}
                        onClose={closeMenu}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
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

interface AnswerMenuProps {
  id: string;
  side: Side;
  /** The `id` of the button that opened it, which names it. */
  labelledBy: string;
  answers: readonly ApprovalAnswer[];
  personName: string | undefined;
  /** Where focus lands when it opens. */
  focus: 'first' | 'last';
  onChoose: (answer: ApprovalAnswer) => void;
  /** Escape, Tab, a click outside, or focus leaving it; `true` gives focus back to its button. */
  onClose: (returnFocus: boolean) => void;
}

/**
 * One side's answers as a menu, under its button: each item says what it does, over a quieter line.
 * It opens with focus on its first item (or its last, from Up); Down and Up move and wrap, Home and
 * End jump, Enter or Space chooses, and Escape or Tab closes it with focus back on its button.
 */
function AnswerMenu({ id, side, labelledBy, answers, personName, focus, onChoose, onClose }: AnswerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // The latest onClose, for the document listener below.
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    items[focus === 'first' ? 0 : items.length - 1]?.focus();
  }, [focus]);

  // A press outside the menu and its button closes it, and leaves focus where the press puts it.
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || doc.getElementById(labelledBy)?.contains(target))) return;
      close.current(false);
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [labelledBy]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? items.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  // Focus that leaves for anything but the menu or its button, a screen reader's move say, closes it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next === null || event.currentTarget.contains(next)) return;
    if (event.currentTarget.ownerDocument.getElementById(labelledBy)?.contains(next)) return;
    onClose(false);
  };

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      className={`cd-approval-card__menu cd-approval-card__menu--${side}`}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {answers.map((value) => (
        // Named by its words alone; its line is its description, read once, after the name.
        <button
          key={value}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-describedby={`${id}-${value}-line`}
          className="cd-approval-card__item"
          onClick={() => onChoose(value)}
        >
          <span className="cd-approval-card__item-words cd-type-control">{itemWords(value, personName)}</span>
          <span id={`${id}-${value}-line`} aria-hidden="true" className="cd-approval-card__item-line cd-type-caption">
            {ANSWERS[value].line}
          </span>
        </button>
      ))}
    </div>
  );
}
