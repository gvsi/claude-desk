import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { ApprovalAnswer, Decision } from '../../../api/contracts.ts';
import { Button, type ButtonVariant } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';
import { OWNER_STATE_WORDS, receiptTone } from '../MarginReceipt/receiptTone.ts';
import { Notice } from '../Notice/Notice.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { RuleSentence, type RuleSentenceProps } from '../RuleSentence/RuleSentence.tsx';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';
import { ApprovalStatus } from './ApprovalStatus.tsx';

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

/** The label over the rule that held the request. */
const RULE_LABEL = 'Your rule';

/**
 * The rule that held a request, as the screen words it (`heldRule`): one rule sentence led by
 * Claude, the tools it covers and who, and its outcome. The design system words none of it.
 */
export type ApprovalRule = Pick<RuleSentenceProps, 'parts' | 'meta' | 'outcome'>;

const SENDING_LINE = 'Sending your answer';
const ERROR_LINE = "We couldn't confirm your answer. Try again, or reload to see where it stands.";

/**
 * How long past its own transition the settle waits for the height's `transitionend` before it
 * ends itself: a settle whose height doesn't change, or a browser that drops the event, still ends.
 */
const SETTLE_SLACK_MS = 100;

export interface ApprovalCardProps {
  /** The held request, as the kernel returned it. Its `state` and `answers` decide what the card offers. */
  decision: Decision;
  /**
   * The rule that held it, as REV-RULES-B5 draws it: a "Your rule" box under what was asked, with
   * the rule's sentence, the tools it covers and who, and its outcome. Leave it out when no rule of
   * the owner's held it (only the default ask did, or its rule has changed): there is no box then.
   */
  rule?: ApprovalRule;
  /**
   * One line of context in meta type; mark a visitor's own words with `data-copy="user"`. The
   * visitor's own words only: never AI-written text such as a triage summary, which a visitor could
   * steer to sway the answer (master plan, "never in approval cards").
   */
  context?: ReactNode;
  /** Where and when it was held: "Web chat, 2 min ago". */
  waiting: string;
  /**
   * The request came from a demo visitor's chat, an AI the owner started to play a customer: a "Demo
   * visitor" pill after where and when it was held, so it's never taken for a real customer's.
   */
  demoVisitor?: boolean;
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
  /**
   * Vision pages only, which make no requests: the answers keep their look, focus and tab order, a
   * menu still opens, and choosing an answer does nothing. The card never locks or shows a spinner,
   * `onAnswer` is never called, and no answer ever lands.
   */
  inertAnswers?: boolean;
  /**
   * What sits under the card, outside it, such as the rule an "always" answer drafted and Today's
   * Dismiss once the request is answered. Given with an answer given on this card, it fades in and
   * settles with the answered card, inside its eased height.
   */
  after?: ReactNode;
  /**
   * Called with the card's own box (without `after`) as it mounts and unmounts. Given, the box takes
   * focus (`tabIndex={-1}`), so a screen can bring the request into view and focus.
   */
  cardRef?: (el: HTMLDivElement | null) => void;
}

/** The click that is waiting for its result, and the screen's `pending` and `error` it last saw. */
interface AnswerLock {
  /** Which click this is, so a late rejection releases only its own lock. */
  click: number;
  /** The side whose answer was chosen: its button shows the busy spinner while the answer is sent. */
  side: Side;
  key: string;
  pending: boolean;
  error: boolean | string | undefined;
  /** The request as it was held when the answer was given, and whether `after` was shown then. */
  held: Decision;
  hadAfter: boolean;
}

/**
 * An answer given on this card landing: the held request drawn as it left, in the outgoing layer,
 * while the answered one fades in and the card eases to its answered height.
 */
interface Settle {
  /** The request as it was held, its chosen side busy and the other waiting, as they were. */
  held: Decision;
  side: Side;
  /** The dot left held, so it pulses once. */
  pulse: boolean;
  /** `after` came with the answer, so it fades in and its height eases in with the card's. */
  afterNew: boolean;
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

/** Each side the answers offer, in the card's order, with its answers. */
function sidesOf(offered: readonly ApprovalAnswer[]): { side: Side; answers: ApprovalAnswer[] }[] {
  return SIDE_ORDER.map((side) => ({ side, answers: offered.filter((value) => ANSWERS[value].side === side) })).filter(
    ({ answers }) => answers.length > 0,
  );
}

/**
 * Whether the browser asks for reduced motion. The base stylesheet stops every animation then; the
 * settle also skips its outgoing layer and its height lock, so the answered card draws at once.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The longest of an element's transitions, delay included, in milliseconds. */
function transitionMs(el: Element): number {
  const style = getComputedStyle(el);
  const ms = (value: string) => (value.trim().endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000) || 0;
  const durations = style.transitionDuration.split(',').map(ms);
  const delays = style.transitionDelay.split(',').map(ms);
  return Math.max(0, ...durations.map((duration, i) => duration + (delays[i % delays.length] ?? 0)));
}

/**
 * A request the owner's rules held: what was asked, the rule that held it, and only the answers
 * the kernel offers while it is held, as two controls, Allow and Deny. A side with one answer is a
 * plain button; a side with two opens a menu of them. After an answer or an event, the final line
 * takes the place of "Waiting for your answer" with its receipt dot, and the answers go. An answer
 * given on this card lands: the held card fades out as the answered one fades in, with `after`
 * under it, the dot pulses once if it leaves held, and the card eases to its answered height.
 */
export function ApprovalCard({
  decision,
  rule,
  context,
  waiting,
  demoVisitor = false,
  personName,
  onAnswer,
  pending = false,
  error,
  inertAnswers = false,
  after,
  cardRef,
}: ApprovalCardProps) {
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
  // On a vision page: whether an answer has been chosen, so its line shows from then on.
  const [inertPressed, setInertPressed] = useState(false);
  const clicks = useRef(0);
  const hasAfter = after !== undefined && after !== null && after !== false;
  const tone = receiptTone({ kind: 'decision', state: decision.state });
  // An answer given on this card landing, while it settles.
  const [settle, setSettle] = useState<Settle | null>(null);
  let locked = false;
  // The side whose answer is being sent, while this card knows it; null when the screen reports
  // `pending` for an answer sent from somewhere else.
  let chosen: Side | null = null;
  if (lock !== null) {
    if (lock.key !== answerKey) {
      // The request left held with this card's answer out: the answer lands, unless the browser asks
      // for reduced motion, when the answered card draws at once. A vision page's inert card never
      // sends an answer, so it never lands one.
      if (!inertAnswers && lock.held.decision_id === decision.decision_id && !showAnswers && !prefersReducedMotion()) {
        setSettle({ held: lock.held, side: lock.side, pulse: tone !== 'held', afterNew: hasAfter && !lock.hadAfter });
      }
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
  if (locked && lock !== null) chosen = lock.side;
  const waitingForResult = pending || locked;

  // The settle's parts: the card and what follows it (one region), the card's box and its body,
  // which holds the answered layer and, while it settles, the outgoing one in the same place.
  const regionRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef<HTMLDivElement | null>(null);
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      cardRef?.(el);
    },
    [cardRef],
  );
  // The outgoing layer is out of reach from its first frame: no pointer, key or find-in-page.
  const setLeaving = useCallback((el: HTMLDivElement | null) => {
    leavingRef.current = el;
    el?.setAttribute('inert', '');
  }, []);

  // When the answers go while one of them had focus, focus moves to the status line, so a
  // keyboard user isn't dropped to the top of the page. The answers go from the answered layer in
  // the commit that lands the answer, and the outgoing layer is drawn afresh, inert and hidden from
  // its first frame, so focus never stays on a control that can't be reached.
  const statusRef = useRef<HTMLSpanElement>(null);
  const answeredHere = useRef(false);
  useLayoutEffect(() => {
    if (showAnswers || !answeredHere.current) return;
    answeredHere.current = false;
    const status = statusRef.current;
    const active = status?.ownerDocument.activeElement;
    if (status && (active == null || active === status.ownerDocument.body || leavingRef.current?.contains(active))) status.focus();
  }, [showAnswers]);

  // The card eases from its held height to its answered height, and the region with it, so what
  // follows glides instead of jumping. Each height is measured, locked where it was, then set to
  // where it ends; the stylesheet's transition carries it between them, after the crossfade.
  useLayoutEffect(() => {
    const region = regionRef.current;
    const box = boxRef.current;
    const body = bodyRef.current;
    const live = liveRef.current;
    const leaving = leavingRef.current;
    if (settle === null || !region || !box || !body || !live || !leaving) return undefined;
    const heldBody = leaving.offsetHeight;
    const answeredBody = live.offsetHeight;
    // The two layers share one grid cell, so the body is now as tall as the taller of them.
    const shared = body.offsetHeight;
    const now = region.offsetHeight;
    const afterBlock = settle.afterNew ? now - box.offsetHeight : 0;
    body.style.height = `${heldBody}px`;
    region.style.height = `${now - (shared - heldBody) - afterBlock}px`;
    // Read back, so the browser starts the transition from the held heights.
    void region.offsetHeight;
    body.style.height = `${answeredBody}px`;
    region.style.height = `${now - (shared - answeredBody)}px`;

    const end = () => setSettle(null);
    const onEnd = (event: TransitionEvent) => {
      if (event.target === region && event.propertyName === 'height') end();
    };
    region.addEventListener('transitionend', onEnd);
    region.addEventListener('transitioncancel', onEnd);
    const fallback = window.setTimeout(end, transitionMs(region) + SETTLE_SLACK_MS);
    return () => {
      region.removeEventListener('transitionend', onEnd);
      region.removeEventListener('transitioncancel', onEnd);
      window.clearTimeout(fallback);
      region.style.height = '';
      body.style.height = '';
    };
  }, [settle]);

  const answer = (value: ApprovalAnswer) => {
    // A vision page's card: the answer goes nowhere, so nothing waits for it, and the line says why.
    if (inertAnswers) {
      setInertPressed(true);
      return;
    }
    if (waitingForResult) return;
    answeredHere.current = true;
    clicks.current += 1;
    const click = clicks.current;
    setLock({ click, side: ANSWERS[value].side, key: answerKey, pending, error, held: decision, hadAfter: hasAfter });
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

  const sides = sidesOf(offered);

  const words = { rule, context, waiting, demoVisitor };
  const regionClass = ['cd-approval-card', settle ? 'cd-approval-card--settling' : '', settle?.pulse ? 'cd-approval-card--pulse' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={regionRef} className={regionClass}>
      <div ref={setBox} className="cd-approval-card__card" tabIndex={cardRef ? -1 : undefined}>
        <Card as="article" label={`${OWNER_STATE_WORDS.held}: ${decision.reason_plain}`}>
          <div ref={bodyRef} className="cd-approval-card__body">
            <div ref={liveRef} className="cd-approval-card__layer cd-approval-card__layer--live">
              <RequestWords decision={decision} tone={tone} statusRef={statusRef} {...words} />
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
                              busy={waitingForResult && chosen === side}
                              waiting={waitingForResult && chosen !== side}
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
                  {/* Read out, unseen: the busy answer carries the wait, so the card keeps its height until the answer lands. */}
                  <p role="status" className="cd-sr-only">
                    {pending ? SENDING_LINE : null}
                  </p>
                  {inertAnswers ? <VisionInertLine shown={inertPressed} /> : null}
                  {failed && !pending ? (
                    <div className="cd-approval-card__error">
                      <Notice tone="error">{error === true ? ERROR_LINE : error}</Notice>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {settle !== null ? (
              <div ref={setLeaving} aria-hidden="true" className="cd-approval-card__layer cd-approval-card__layer--leaving">
                <RequestWords decision={settle.held} tone="held" {...words} />
                <LeavingAnswers settle={settle} personName={personName} />
              </div>
            ) : null}
          </div>
        </Card>
      </div>
      {hasAfter ? <div className={`cd-approval-card__after${settle?.afterNew ? ' cd-approval-card__after--new' : ''}`}>{after}</div> : null}
    </div>
  );
}

interface RequestWordsProps {
  decision: Decision;
  tone: StatusTone;
  rule: ApprovalRule | undefined;
  context: ReactNode;
  waiting: string;
  demoVisitor: boolean;
  /** The answered layer's status line: the one `role="status"` node, which takes focus when the answers go. */
  statusRef?: RefObject<HTMLSpanElement>;
}

/** The rule that held the request, in a box of its own under what was asked, named by its label. */
function HeldRule({ rule }: { rule: ApprovalRule }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="cd-approval-card__rule">
      <p id={labelId} className="cd-approval-card__rule-label cd-type-caption">
        {RULE_LABEL}
      </p>
      <RuleSentence {...rule} />
    </div>
  );
}

/** What the card says: its status line and when it was held, what was asked, and the rule that held it. */
function RequestWords({ decision, tone, rule, context, waiting, demoVisitor, statusRef }: RequestWordsProps) {
  return (
    <>
      <div className="cd-approval-card__top cd-type-caption">
        <ApprovalStatus decision={decision} tone={tone} statusRef={statusRef} />
        {demoVisitor ? (
          <span className="cd-approval-card__waiting cd-approval-card__waiting--tagged">
            {waiting}
            <Pill>Demo visitor</Pill>
          </span>
        ) : (
          <span className="cd-approval-card__waiting">{waiting}</span>
        )}
      </div>
      <p className="cd-approval-card__reason cd-type-summary">{decision.reason_plain}</p>
      {context ? <p className="cd-approval-card__context cd-type-meta">{context}</p> : null}
      {rule === undefined ? null : <HeldRule rule={rule} />}
    </>
  );
}

/** Does nothing: the outgoing layer's answers are a picture of the ones that went. */
function noAnswer(): void {}

/**
 * The answers as they left, in the outgoing layer: the chosen side busy and the other waiting. The
 * layer is inert and hidden, so none of it can be reached; it draws the last held frame so the
 * crossfade starts from what the owner saw.
 */
function LeavingAnswers({ settle, personName }: { settle: Settle; personName: string | undefined }) {
  return (
    <div className="cd-approval-card__answers">
      <div className="cd-approval-card__row">
        {sidesOf(offeredAnswers(settle.held)).map(({ side, answers }) => {
          const [only] = answers;
          const single = answers.length === 1 ? only : undefined;
          return (
            <div key={side} className="cd-approval-card__side">
              <Button
                variant={SIDES[side].variant}
                size="main"
                busy={side === settle.side}
                waiting={side !== settle.side}
                menuOpen={single === undefined ? false : undefined}
                onClick={noAnswer}
              >
                {single === undefined ? SIDES[side].word : buttonWords(single, personName)}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
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
