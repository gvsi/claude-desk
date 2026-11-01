import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { Decision } from '../../api/contracts.ts';
import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Icon, Notice, Pill, StatusDot, SuggestionChips, TextLink, type IconName } from '../../ds/index.ts';
import { breakItIdeas, handOffBreakItIdea, type BreakItIdea } from '../../lib/breakItIdeas.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { VISION_ARTICLE } from '../../about/links.ts';
import { customerLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, useToday } from '../useDesks.ts';
import { TODAY_COPY } from '../today/copy.ts';
import { doneCaption, type UncountedAnswer } from './doneSignals.ts';
import { THINGS_TO_TRY, UNCOUNTED_ANSWER_LINES } from './ideas.ts';
import { useDoneSignals, type Done } from './useDoneSignals.ts';

export interface ThingsToTryProps {
  /**
   * The oldest request still held or with its answer still out, which "Answer a held request" waits
   * for; null while there is none.
   */
  firstHeld: NeedsYouItem | null;
  /** The final decisions of the requests answered on Today in this view. */
  answered: Iterable<{ state: Decision['state'] }>;
  /** The final decision of the request answered on Today last, kept when its card is dismissed. */
  latestAnswer: { decision_id: string; state: Decision['state']; owner_plain?: string | null } | null;
  /** "Open the request": brings the held request's card into view and focus. */
  onFocusRequest: () => void;
}

const [CHAT, BREAK, ANSWER, CREATE] = THINGS_TO_TRY;

/**
 * How a row ended, as it draws it: the line that takes the detail's place (null keeps the detail);
 * whether it ticked (done, with a check and a Done pill) or only settled (an answer the list doesn't
 * count: its line alone); and whether it was so at load.
 */
interface RowEnd extends Done {
  line: string | null;
  ticks: boolean;
}

function rowDone(done: Done | undefined, line: string | null): RowEnd | null {
  return done === undefined ? null : { ...done, line, ticks: true };
}

/** What happened to the "Try to break it" idea the owner picked, by its key. */
interface Pick {
  key: BreakItIdea['key'];
  /**
   * The token of the hand-off this pick made, which the blocked tab's link carries too; null when
   * this browser's storage wouldn't keep it, and the page opens with nothing typed in.
   */
  token: string | null;
  /** Counts the picks, so each one draws its line afresh and a screen reader hears it again. */
  n: number;
  /** `opened`: the public page opened in a new tab, the idea in its chat box. `blocked`: the browser kept the tab from opening. */
  outcome: 'opened' | 'blocked';
}

/** "Held by your rule: {rule}." without doubling the rule's own full stop. */
function heldLine(rule: string | null | undefined): ReactNode {
  if (!rule) return TODAY_COPY.waiting;
  const ends = /[.!?]$/.test(rule.trim());
  return (
    <>
      {TODAY_COPY.waiting} {TODAY_COPY.heldBy}<span data-copy="user">{rule.trim()}</span>
      {ends ? '' : '.'}
    </>
  );
}

/** A plain left click goes through the router; a modified one (a new tab, a new window) is the browser's. */
function routerClick(go: () => void) {
  return (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go();
  };
}

/**
 * Today's "Things to try": four ways into the demo, each with its next step, ticked off in place as
 * the owner does it, and counted in the line under the heading; then a link to the Vision article,
 * where a Desk could go next. From 640 px they are cards side by side, each next step at its foot;
 * on a phone they are rows in one card, each row the next step itself with a chevron at its right.
 * "Answer a held request" says where a request will show until something is held (no next step, so
 * the four keep their places), and stays once it's answered: ticked when the answer counts, or settled in its slot with how the answer ended when
 * it doesn't (a request that had expired or been cancelled, or an answer given on a Desk the list
 * doesn't count). The public page always opens in a new tab, never on Today. "Hide this list" is
 * remembered in this browser when it can be, and a hidden list reads nothing.
 */
export function ThingsToTry({ firstHeld, answered, latestAnswer, onFocusRequest }: ThingsToTryProps) {
  const { business, desk } = useOwnerDesk();
  const today = useToday(desk.desk_id, { retryOnMount: false });
  const navigate = useNavigate();
  const titleId = useId();
  const [hidden, setHidden] = useState(() => readLocal('thingsToTryHidden') === 'true');
  const signals = useDoneSignals({ enabled: !hidden, deskId: desk.desk_id, answered, latest: latestAnswer });
  // The row settles with how the latest answer given here ended, when the list doesn't count it, and
  // keeps that line when its card is dismissed. A new request held clears it: the answer whose line it
  // was is remembered here, so the line doesn't come back once that request is gone.
  const waiting = firstHeld?.decision != null;
  const latestId = latestAnswer?.decision_id ?? null;
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  if (waiting && latestId !== null && latestId !== clearedFor) setClearedFor(latestId);
  const settledAs: UncountedAnswer | null = !waiting && latestId !== null && latestId !== clearedFor ? signals.uncounted : null;
  // After hiding or showing, focus goes to the button that undoes it, rather than to the page.
  const toggleRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    toggleRef.current?.querySelector('button')?.focus();
  }, [hidden]);

  const setHiddenAndRemember = (next: boolean) => {
    moveFocus.current = true;
    setHidden(next);
    writeLocal('thingsToTryHidden', next ? 'true' : null);
  };

  if (hidden) {
    return (
      <div ref={toggleRef} className="cd-things__show">
        <Button variant="ghost" onClick={() => setHiddenAndRemember(false)}>
          Show things to try
        </Button>
      </div>
    );
  }

  const link = customerLink(desk.slug, desk.desk_id);
  const ownerName = today.data?.greeting_name ?? firstName(business.owner_display_name);
  // "Answer a held request": done once answered; else waiting while a request is held (or its answer
  // is still out); else settled, in its slot, by an answer given here that the list doesn't count;
  // else empty: where a request will show, with no next step.
  const answerDone = rowDone(signals.done.answer, signals.onStartingDesk ? ANSWER.done : TODAY_COPY.heldNone);
  const answerEnd: RowEnd | null =
    answerDone ?? (!waiting && settledAs !== null ? {
      line: settledAs === 'refused_at_execution' ? latestAnswer?.owner_plain ?? UNCOUNTED_ANSWER_LINES[settledAs] : UNCOUNTED_ANSWER_LINES[settledAs],
      ticks: false, atLoad: false,
    } : null);
  const answerWaits = answerDone === null && waiting;

  return (
    <section className="cd-things" aria-labelledby={titleId}>
      <div className="cd-things__head">
        <div className="cd-things__head-line">
          <h2 id={titleId} className="cd-things__title cd-type-section">
            Things to try
          </h2>
          <div ref={toggleRef} className="cd-things__hide">
            <Button variant="ghost" onClick={() => setHiddenAndRemember(true)}>
              Hide this list
            </Button>
          </div>
        </div>
        {/* The line keeps the room of its longest wording, so counting never changes its height. */}
        <p className="cd-things__caption cd-type-meta" data-room={doneCaption(0)}>
          <span className="cd-things__caption-now">{doneCaption(signals.count)}</span>
        </p>
      </div>
      <Card padding={16}>
        <ul className="cd-things__list">
          <Thing
            icon="conversations"
            title={CHAT.title}
            detail={TODAY_COPY.chatDetail}
            end={rowDone(signals.done.chat, CHAT.done)}
            step={{ label: 'Open your public page', href: link, external: true }}
          />
          <BreakIt slug={desk.slug} deskId={desk.desk_id} ownerName={ownerName} end={rowDone(signals.done.break, signals.onStartingDesk ? BREAK.done : null)} />
          <Thing
            icon="clock"
            title={ANSWER.title}
            held={answerWaits}
            detail={answerWaits ? heldLine(firstHeld?.held_by) : TODAY_COPY.heldNone}
            end={answerEnd}
            step={answerWaits ? { label: 'Open the request', onClick: onFocusRequest } : null}
          />
          <Thing
            icon="plus"
            title={CREATE.title}
            detail={TODAY_COPY.createDetail}
            end={rowDone(signals.done.create, CREATE.done)}
            step={{ label: 'Start a Desk', href: '/app/setup', onClick: routerClick(() => void navigate('/app/setup')) }}
          />
        </ul>
      </Card>
      <p className="cd-things__vision cd-type-meta">
        <TextLink href={VISION_ARTICLE.route}>{TODAY_COPY.vision}</TextLink>
      </p>
    </section>
  );
}

/**
 * A row's next step: a link (`href`, in a new tab when `external`) or a button. From 640 px it is a
 * secondary button at the card's foot, named by `label`; on a phone the whole row is it, named by
 * the row's title, with a chevron at its right.
 */
interface Step {
  label: string;
  href?: string;
  external?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  /** A step that shows or hides something under the row: whether it is showing. */
  expanded?: boolean;
}

interface ThingProps {
  icon: IconName;
  title: string;
  /** A held dot beside the title: something is waiting. */
  held?: boolean;
  detail: ReactNode;
  /** Shown under the detail, across the row. */
  below?: ReactNode;
  /** Set once the row has ended: it ticks off when its thing is done, or settles with its line alone. */
  end?: RowEnd | null;
  /** The row's next step; null for a row with none yet. */
  step: Step | null;
}

/**
 * How long past its own transition a row's settle waits for `transitionend` before it ends itself:
 * a browser that drops the event still lets the row take its own height.
 */
const SETTLE_SLACK_MS = 100;

/**
 * Whether the browser asks for reduced motion. The base stylesheet stops every transition then; a
 * ticking row also keeps no height, so its end state draws at once.
 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The longest of an element's transitions, delay included, in milliseconds. */
function transitionMs(el: Element): number {
  const style = getComputedStyle(el);
  const ms = (value: string) => (value.trim().endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000) || 0;
  const durations = style.transitionDuration.split(',').map(ms);
  const delays = style.transitionDelay.split(',').map(ms);
  return Math.max(0, ...durations.map((duration, i) => duration + (delays[i % delays.length] ?? 0)));
}

/** A ticked row easing from the height it had to its own, both measured. */
interface Settle {
  from: number;
  to: number;
}

/**
 * What happens to a row as it turns done in view, in the commit that ticks it, before paint:
 * - Its height, when it ticks in view (`eases`, its check drawing): the whole row's height as it
 *   stood (its open ideas included) holds while the check draws, then eases to the done row's own
 *   height (`motion-base`, emphasis ease), so what's below glides up once instead of jumping. The
 *   stylesheet's transition carries it between the two measured heights, and the row lets go on
 *   `transitionend` or `transitioncancel`, with a fallback. Under reduced motion, and for a row done
 *   before Today opened, the row takes its own height at once: there is no change of the owner's to
 *   show.
 * - Focus: the button or idea that had it is gone, so focus that was in the row goes to its title
 *   rather than falling to the page. Focus anywhere else is left alone.
 */
function useTickInPlace(done: boolean, eases: boolean) {
  const ref = useRef<HTMLLIElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The row's height while it isn't done, kept up to date as it changes.
  const before = useRef<number | null>(null);
  const wasDone = useRef(done);
  // Whether focus is in the row, as the row's own focus events last said.
  const focusInside = useRef(false);
  const [settle, setSettle] = useState<Settle | null>(null);

  useLayoutEffect(() => {
    const item = ref.current;
    if (item === null) return;
    if (!done) {
      before.current = item.getBoundingClientRect().height;
      wasDone.current = false;
      return;
    }
    if (wasDone.current) return;
    wasDone.current = true;
    const active = document.activeElement;
    if (focusInside.current && (active === null || active === document.body)) titleRef.current?.focus({ preventScroll: true });
    const from = before.current;
    const to = item.getBoundingClientRect().height;
    if (eases && from !== null && from - to > 0.5 && !prefersReducedMotion()) setSettle({ from, to });
  });

  // The settle, before paint: locked at the height the row had, then set to its own height, which the
  // stylesheet's transition reaches once the check has drawn.
  useLayoutEffect(() => {
    const item = ref.current;
    if (settle === null || item === null) return undefined;
    item.style.minHeight = `${settle.from}px`;
    // Read back, so the browser starts the transition from the height the row had.
    void item.offsetHeight;
    item.style.minHeight = `${settle.to}px`;
    const end = () => setSettle(null);
    const onEnd = (event: TransitionEvent) => {
      if (event.target === item && event.propertyName === 'min-height') end();
    };
    item.addEventListener('transitionend', onEnd);
    item.addEventListener('transitioncancel', onEnd);
    const fallback = window.setTimeout(end, transitionMs(item) + SETTLE_SLACK_MS);
    return () => {
      item.removeEventListener('transitionend', onEnd);
      item.removeEventListener('transitioncancel', onEnd);
      window.clearTimeout(fallback);
      item.style.minHeight = '';
    };
  }, [settle]);

  useEffect(() => {
    const item = ref.current;
    if (item === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (!wasDone.current) before.current = item.getBoundingClientRect().height;
    });
    observer.observe(item);
    return () => observer.disconnect();
  }, []);

  return {
    ref,
    titleRef,
    settling: settle !== null,
    onFocus: () => {
      focusInside.current = true;
    },
    onBlur: (event: FocusEvent<HTMLLIElement>) => {
      focusInside.current = event.currentTarget.contains(event.relatedTarget as Node | null);
    },
  };
}

/**
 * One thing to try. Once it's done, its icon gives way to a check, its detail to its done line and
 * its next step to a Done pill, in place, at the height it had until the check has drawn. A row that
 * settles instead (an answer the list doesn't count) keeps its icon, and its detail gives way to its
 * line, with no check, no pill and no next step, in the same settle. The check draws, and the line
 * comes in, when the row ends in view; a row that ended at load, or before it was drawn (a list
 * shown again), is drawn still.
 */
function Thing({ icon, title, held = false, detail, below, end = null, step }: ThingProps) {
  const titleId = useId();
  const detailId = useId();
  // Ended when it was drawn: drawn still. A row that waits again (a new request held) ends in view next time.
  const [drawnEnded, setDrawnEnded] = useState(end !== null);
  if (end === null && drawnEnded) setDrawnEnded(false);
  const inView = end !== null && !end.atLoad && !drawnEnded;
  const { ref, titleRef, settling, onFocus, onBlur } = useTickInPlace(end !== null, inView);
  return (
    <li ref={ref} className={settling ? 'cd-things__item cd-things__item--settling' : 'cd-things__item'} onFocus={onFocus} onBlur={onBlur}>
      <span className="cd-things__icon">
        {end?.ticks ? (
          <Icon name="check" size={16} className={inView ? 'cd-things__check cd-things__check--draws' : 'cd-things__check'} />
        ) : (
          <Icon name={icon} size={16} />
        )}
      </span>
      <div className="cd-things__text">
        <h3 ref={titleRef} id={titleId} className="cd-things__item-title cd-type-control" tabIndex={-1}>
          {title}
          {held && end === null ? <StatusDot tone="held" /> : null}
        </h3>
        <p id={detailId} className={inView ? 'cd-things__detail cd-things__detail--done cd-type-meta' : 'cd-things__detail cd-type-meta'}>
          {end?.line ?? detail}
        </p>
      </div>
      {/* A settled row has no next step and no pill, so no place for one either; nor has a row with no step yet. */}
      {end === null && step !== null ? (
        <>
          <div className="cd-things__action">
            {step.href !== undefined ? (
              <Button variant="secondary" href={step.href} external={step.external} onClick={step.onClick}>
                {step.label}
              </Button>
            ) : (
              <Button variant="secondary" onClick={step.onClick}>
                {step.label}
              </Button>
            )}
          </div>
          <RowStep step={step} labelledBy={titleId} describedBy={detailId} />
        </>
      ) : null}
      {end?.ticks ? (
        <div className="cd-things__action cd-things__action--done">
          {/* The done line already says it in words, so the pill isn't read twice. */}
          <span className={inView ? 'cd-things__done cd-things__done--ticked' : 'cd-things__done'} aria-hidden="true">
            <Pill>
              <StatusDot tone="handled" />
              Done
            </Pill>
          </span>
        </div>
      ) : null}
      {below && end === null ? <div className="cd-things__below">{below}</div> : null}
    </li>
  );
}

/**
 * A row's next step on a phone: a chevron at the row's right whose press area is the whole row, named
 * by the row's title and described by its line, with the focus ring around the row. From 640 px it
 * isn't drawn, and the card's button is the step.
 */
function RowStep({ step, labelledBy, describedBy }: { step: Step; labelledBy: string; describedBy: string }) {
  const chevron = <Icon name="chevron-right" size={16} />;
  if (step.href !== undefined) {
    return (
      <a
        className="cd-things__go"
        href={step.href}
        target={step.external ? '_blank' : undefined}
        rel={step.external ? 'noopener noreferrer' : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onClick={step.onClick}
      >
        {chevron}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="cd-things__go"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-expanded={step.expanded}
      onClick={step.onClick}
    >
      {chevron}
    </button>
  );
}

/**
 * "Try to break it": the fixed ideas, the one that speaks as the owner in this Desk's owner's name
 * (`breakItIdeas`). A pick hands the idea to the public page through this browser's storage
 * (`handOffBreakItIdea`) and opens the page in a new tab with the hand-off's
 * one-time token in its link (`?try=`), never the idea's key or words; the page types the idea into
 * its chat box for the owner to send. Nothing is sent without their Send, and nothing is written to
 * the owner's clipboard. The tab opens in the click itself, so the browser counts it as the owner's
 * own. It is opened without `noopener` (with it the browser hides whether the tab opened), and this
 * page cuts the new tab's link back to it. A browser that blocks the tab gets a link to open it by
 * hand, with the same token. When this browser's storage won't keep the hand-off, there is no token
 * to promise the idea by: the page opens with nothing typed in, and the line says to type it there.
 */
/** The fallback when the browser blocked the new tab: the public page by hand, in a new tab. */
function openByHand(href: string): ReactNode {
  return (
    <Button variant="secondary" href={href} external>
      Open your public page
    </Button>
  );
}

function BreakIt({ slug, deskId, ownerName, end }: { slug: string; deskId: string; ownerName: string; end: RowEnd | null }) {
  const [showing, setShowing] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  // The ideas in this Desk's own words: the one that speaks as the owner names this Desk's owner.
  const ideas = breakItIdeas(ownerName);

  const onPick = (text: string) => {
    const idea = ideas.find((each) => each.text === text);
    if (idea === undefined) return;
    const n = (pick?.n ?? 0) + 1;
    const token = handOffBreakItIdea(slug, idea.key);
    const link = customerLink(slug, deskId, token ?? undefined);
    const tab = window.open(link, '_blank');
    if (tab === null) {
      setPick({ key: idea.key, token, n, outcome: 'blocked' });
      return;
    }
    tab.opener = null;
    setPick({ key: idea.key, token, n, outcome: 'opened' });
  };

  const below = showing ? (
    <div className="cd-things__ideas">
      <SuggestionChips label="Ideas to try" suggestions={ideas.map((idea) => idea.text)} onPick={onPick} />
      {pick !== null && pick.token === null ? (
        <Notice key={pick.n} tone="info" action={pick.outcome === 'blocked' ? openByHand(customerLink(slug, deskId)) : undefined}>
          Your browser didn't let Today pass the idea on. Type it in the new tab.
        </Notice>
      ) : null}
      {pick?.outcome === 'opened' && pick.token !== null ? (
        <Notice key={pick.n} tone="info">
          The new tab opens with the idea in its chat box. Send it from there.
        </Notice>
      ) : null}
      {pick?.outcome === 'blocked' && pick.token !== null ? (
        <Notice key={pick.n} tone="info" action={openByHand(customerLink(slug, deskId, pick.token))}>
          Your browser blocked the new tab. This link opens it with the idea typed in.
        </Notice>
      ) : null}
    </div>
  ) : null;

  return (
    <Thing
      icon="safety"
      title={BREAK.title}
      detail={
        <>
          {TODAY_COPY.breakBeforeOwner}<span data-copy="user">{ownerName}</span>{TODAY_COPY.breakAfterOwner}
        </>
      }
      below={below}
      end={end}
      step={{
        label: showing ? 'Hide ideas' : 'Show me ideas',
        expanded: showing,
        onClick: () => {
          setShowing(!showing);
          setPick(null);
        },
      }}
    />
  );
}
