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

/** An answer's words, or, for one that names the person, its words around them. */
type Words = string | ((person: ReactNode) => ReactNode);

/**
 * Each answer's side and words, in the order a side offers them: the one-time answer, then the
 * one that also saves a rule. `button` is its plain button when it is its side's only answer;
 * `item` and `line` are its menu item. Allow only for this person's words take the person: their
 * name on record, or "this person". This table is the only source of the answers' words, and a
 * missing answer is a compile error.
 */
const ANSWERS = {
  allow_once: { side: 'allow', button: 'Allow this time', item: 'This time', line: ONCE_LINE },
  allow_person: {
    side: 'allow',
    button: (person) => <>Allow only for {person}, always</>,
    item: (person) => <>Only for {person}, always</>,
    line: RULE_LINE,
  },
  deny_once: { side: 'deny', button: 'Deny this time', item: 'This time', line: ONCE_LINE },
  deny_always: { side: 'deny', button: 'Deny always', item: 'Always', line: RULE_LINE },
} as const satisfies Record<ApprovalAnswer, { side: Side; button: Words; item: Words; line: string }>;

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
  /** The decision, its state and the answers it offered when the menu opened (`menuKey`). */
  key: string;
  /** Which opening this is, so each one moves focus into the menu, even to the same item. */
  openedAt: number;
  /** The Enter that opened it, which may still be down as focus lands on an item. */
  heldKey: 'Enter' | null;
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

/** Words as shown for this person. */
function say(words: Words, personName: string | undefined): ReactNode {
  return typeof words === 'string' ? words : words(personWords(personName));
}

/** An answer's words on a plain button. */
function buttonWords(answer: ApprovalAnswer, personName: string | undefined): ReactNode {
  return say(ANSWERS[answer].button, personName);
}

/** An answer's words as a menu item. */
function itemWords(answer: ApprovalAnswer, personName: string | undefined): ReactNode {
  return say(ANSWERS[answer].item, personName);
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
  // What a menu was opened on: the decision, its state and the answers it offers.
  const menuKey = `${answerKey}\n${offered.join(' ')}`;

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

  // One menu at a time. It opens only on the owner's click or key, and once an answer starts to be
  // sent or the answers change it is gone, not hidden, so it can't come back on its own.
  const [open, setOpen] = useState<OpenMenu | null>(null);
  if (open !== null && (open.key !== menuKey || waitingForResult)) setOpen(null);
  const menuSide = open !== null && open.key === menuKey && !waitingForResult ? open.side : null;
  const openings = useRef(0);
  const openMenu = (side: Side, focus: OpenMenu['focus'], heldKey: OpenMenu['heldKey'] = null) => {
    openings.current += 1;
    setOpen({ side, focus, key: menuKey, openedAt: openings.current, heldKey });
  };
  const closeMenu = () => setOpen(null);
  const ids = useId();
  const buttonId = (side: Side) => `${ids}-${side}`;

  // A click on an open menu's button closes it; the menu gives focus back to the button, whichever
  // browser it is.
  const toggleMenu = (side: Side) => {
    if (menuSide === side) closeMenu();
    else openMenu(side, 'first');
  };
  // Enter opens or closes the menu as it goes down, so the menu knows that key may still be held;
  // Down and Up open the menu, or move focus back into it while it is open; Escape closes it and
  // leaves focus on the button.
  const onMenuButtonKey = (side: Side, event: KeyboardEvent<HTMLButtonElement>) => {
    if (waitingForResult) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      if (menuSide === side) closeMenu();
      else openMenu(side, 'first', 'Enter');
      return;
    }
    if (event.key === 'Escape') {
      if (menuSide !== side) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu(side, event.key === 'ArrowDown' ? 'first' : 'last');
  };
  // Focus that leaves a side, its button and its menu, for anything else on the page closes its
  // menu, and stays where it went. Focus that leaves the page, or a press on the menu's own padding,
  // has nowhere to go and closes nothing.
  const onSideBlur = (side: Side, event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next === null || event.currentTarget.contains(next)) return;
    setOpen((current) => (current?.side === side ? null : current));
  };
  // The menu goes and gives focus back to its button, where it waits while the answer is sent.
  const choose = (value: ApprovalAnswer) => {
    closeMenu();
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
            role="group"
            aria-label="Your answer"
            aria-busy={waitingForResult || undefined}
            className="cd-approval-card__answers"
          >
            <div className="cd-approval-card__row">
              {sides.map(({ side, answers }) => {
                // Each side keeps one button, a plain one or a menu button, so focus stays on it when
                // its answers change.
                const [only] = answers;
                const single = answers.length === 1 ? only : undefined;
                const isOpen = single === undefined && menuSide === side;
                return (
                  <div key={side} className="cd-approval-card__side" onBlur={(event) => onSideBlur(side, event)}>
                    <Button
                      id={buttonId(side)}
                      variant={SIDES[side].variant}
                      size="main"
                      busy={waitingForResult}
                      menuOpen={single === undefined ? isOpen : undefined}
                      onClick={() => (single === undefined ? toggleMenu(side) : answer(single))}
                      onKeyDown={single === undefined ? (event) => onMenuButtonKey(side, event) : undefined}
                    >
                      {single === undefined ? SIDES[side].word : buttonWords(single, personName)}
                    </Button>
                    {isOpen && open !== null ? (
                      <AnswerMenu
                        id={`${buttonId(side)}-menu`}
                        side={side}
                        labelledBy={buttonId(side)}
                        answers={answers}
                        personName={personName}
                        focus={open.focus}
                        openedAt={open.openedAt}
                        heldKey={open.heldKey}
                        onChoose={choose}
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
  /** Which opening this is: each one moves focus in again. */
  openedAt: number;
  /** A key that opened it and may still be down; until it comes up, it chooses nothing. */
  heldKey: 'Enter' | null;
  onChoose: (answer: ApprovalAnswer) => void;
  /** Escape or Tab in it, a press outside it and its button, or another menu opening. */
  onClose: () => void;
}

/** The one answer menu open on the page, across every card: opening another closes it. */
let pageMenu: { close: () => void } | null = null;

/**
 * One side's answers as a menu, under its button: each item says what it does, over a quieter line.
 * It opens with focus on its first item (or its last, from Up); Down and Up move and wrap, Home and
 * End jump, Enter or Space chooses, and Escape or Tab closes it with focus back on its button.
 * Whatever closes it, focus that was in it goes back to its button.
 */
function AnswerMenu({ id, side, labelledBy, answers, personName, focus, openedAt, heldKey, onChoose, onClose }: AnswerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(heldKey);

  // The latest onClose, for the document listener below.
  const close = useRef(onClose);
  close.current = onClose;

  // Each opening moves focus in, and notes the key that opened it.
  useLayoutEffect(() => {
    held.current = heldKey;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    items[focus === 'first' ? 0 : items.length - 1]?.focus();
  }, [focus, openedAt, heldKey]);

  // However it closes, focus that was in it goes back to its button while the menu is still on the
  // page, so it never falls to the page itself.
  useLayoutEffect(() => {
    const menu = ref.current;
    return () => {
      const doc = menu?.ownerDocument;
      if (menu && doc && menu.contains(doc.activeElement)) doc.getElementById(labelledBy)?.focus();
    };
  }, [labelledBy]);

  // One menu on the page: this one closes any other, in this card or another, after focus has
  // moved into it, so the other gives none back.
  useLayoutEffect(() => {
    const self = { close: () => close.current() };
    pageMenu?.close();
    pageMenu = self;
    return () => {
      if (pageMenu === self) pageMenu = null;
    };
  }, []);

  // A press outside the menu and its button closes it, and leaves focus where the press puts it.
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || doc.getElementById(labelledBy)?.contains(target))) return;
      close.current();
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [labelledBy]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A key held down repeats: a repeated Enter or Space, or the Enter that opened the menu before
    // it comes up, never chooses.
    if ((event.key === 'Enter' || event.key === ' ') && (event.repeat || event.key === held.current)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
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

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      className={`cd-approval-card__menu cd-approval-card__menu--${side}`}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === held.current) held.current = null;
      }}
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
