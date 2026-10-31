import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { Decision } from '../../api/contracts.ts';
import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Icon, Notice, Pill, StatusDot, SuggestionChips, TextLink, type IconName } from '../../ds/index.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { VISION_PATHS } from '../../vision/data.ts';
import { customerLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, useToday } from '../useDesks.ts';
import { doneCaption } from './doneSignals.ts';
import { ATTACK_IDEAS, THINGS_TO_TRY } from './ideas.ts';
import { useDoneSignals, type Done } from './useDoneSignals.ts';

export interface ThingsToTryProps {
  /**
   * The oldest request still held or with its answer still out, which "Answer a held request" waits
   * for; null while there is none.
   */
  firstHeld: NeedsYouItem | null;
  /** The final decisions of the requests answered on Today in this view. */
  answered: Iterable<{ state: Decision['state'] }>;
  /** "Open the request": brings the held request's card into view and focus. */
  onFocusRequest: () => void;
}

const [CHAT, BREAK, ANSWER, CREATE] = THINGS_TO_TRY;

/** A thing's done state as its row draws it: the line that takes the detail's place, and whether it was done at load. */
interface RowDone extends Done {
  line: string;
}

function rowDone(done: Done | undefined, line: string): RowDone | null {
  return done === undefined ? null : { ...done, line };
}

/** What happened to the attack idea the owner picked. */
type Pick =
  | { idea: string; outcome: 'copied' }
  /** Copied, but the browser kept the new tab from opening. */
  | { idea: string; outcome: 'blocked' }
  /** The clipboard refused: the idea is shown selected instead. */
  | { idea: string; outcome: 'failed' };

/** "Held by your rule: {rule}." without doubling the rule's own full stop. */
function heldLine(rule: string | null | undefined): ReactNode {
  if (!rule) return 'A request is waiting for your answer.';
  const ends = /[.!?]$/.test(rule.trim());
  return (
    <>
      A request is waiting for your answer. Held by your rule: <span data-copy="user">{rule.trim()}</span>
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
 * the owner does it, and counted in the line under the heading; then a link to where this is going,
 * the labelled vision pages. "Answer a held request" waits until something is held, and stays once
 * it's done. The public page always opens in a new tab, never on Today. "Hide this list" is
 * remembered in this browser when it can be, and a hidden list reads nothing.
 */
export function ThingsToTry({ firstHeld, answered, onFocusRequest }: ThingsToTryProps) {
  const { business, desk } = useOwnerDesk();
  const today = useToday(desk.desk_id);
  const navigate = useNavigate();
  const titleId = useId();
  const [hidden, setHidden] = useState(() => readLocal('thingsToTryHidden') === 'true');
  const signals = useDoneSignals({ enabled: !hidden, deskId: desk.desk_id, answered });
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
  // "Answer a held request": done once answered, else waiting while a request is held (or its
  // answer is still out), else not drawn.
  const answerDone = rowDone(signals.done.answer, ANSWER.done);
  const answerRow = answerDone !== null ? 'done' : firstHeld?.decision ? 'waiting' : 'absent';

  return (
    <section className="cd-things" aria-labelledby={titleId}>
      <div className="cd-things__head">
        <h2 id={titleId} className="cd-things__title cd-type-section">
          Things to try
        </h2>
        {/* The line keeps the room of its longest wording, so counting never changes its height. */}
        <p className="cd-things__caption cd-type-meta" data-room={doneCaption(0)}>
          <span className="cd-things__caption-now">{doneCaption(signals.count)}</span>
        </p>
        <div ref={toggleRef} className="cd-things__hide">
          <Button variant="ghost" onClick={() => setHiddenAndRemember(true)}>
            Hide this list
          </Button>
        </div>
      </div>
      <Card padding={16}>
        <ul className="cd-things__list">
          <Thing
            icon="conversations"
            title={CHAT.title}
            detail="Your public page opens in a new tab. Ask about a leak, a price or a time."
            done={rowDone(signals.done.chat, CHAT.done)}
          >
            <Button variant="secondary" href={link} external>
              Open your public page
            </Button>
          </Thing>
          <BreakIt link={link} ownerName={ownerName} done={rowDone(signals.done.break, BREAK.done)} />
          {answerRow === 'absent' ? null : (
            <Thing icon="clock" title={ANSWER.title} held detail={heldLine(firstHeld?.held_by)} done={answerDone}>
              <Button variant="secondary" onClick={onFocusRequest}>
                Open the request
              </Button>
            </Thing>
          )}
          <Thing
            icon="plus"
            title={CREATE.title}
            detail="Describe a business in a few sentences. Claude drafts the rules, and you confirm them."
            done={rowDone(signals.done.create, CREATE.done)}
          >
            <Button variant="secondary" href="/app/setup" onClick={routerClick(() => void navigate('/app/setup'))}>
              Start a Desk
            </Button>
          </Thing>
        </ul>
      </Card>
      <p className="cd-things__vision cd-type-meta">
        <TextLink href={VISION_PATHS.cityOffice}>Where this is going: channels, a city office and a team Desk</TextLink>
      </p>
    </section>
  );
}

interface ThingProps {
  icon: IconName;
  title: string;
  /** A held dot beside the title: something is waiting. */
  held?: boolean;
  detail: ReactNode;
  /** Shown under the detail, across the row. */
  below?: ReactNode;
  /** Set once the thing is done: its row ticks off. */
  done?: RowDone | null;
  /** The row's next step, at its right. */
  children: ReactNode;
}

/** Of a row, its own height: the row without the ideas under it, which go once it's done. */
function ownHeight(item: HTMLElement): number {
  const below = item.querySelector<HTMLElement>(':scope > .cd-things__below');
  const height = item.getBoundingClientRect().height;
  if (below === null) return height;
  return height - below.getBoundingClientRect().height - (Number.parseFloat(getComputedStyle(item).rowGap) || 0);
}

/**
 * What stays as a row turns done in view, in the commit that ticks it, before paint:
 * - Its height, kept as its least height: its done line and Done pill can be shorter than the detail
 *   and the button they replace, and nothing below the list may move. A row already done when it was
 *   first drawn keeps its own height, and a change of the row's width (a resized window) lets the
 *   kept height go.
 * - Focus: the button or idea that had it is gone, so focus that was in the row goes to its title
 *   rather than falling to the page. Focus anywhere else is left alone.
 */
function useTickInPlace(done: boolean) {
  const ref = useRef<HTMLLIElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The row's own height while it isn't done, kept up to date as it changes.
  const before = useRef<number | null>(null);
  const wasDone = useRef(done);
  // Whether focus is in the row, as the row's own focus events last said.
  const focusInside = useRef(false);
  const [kept, setKept] = useState<{ height: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const item = ref.current;
    if (item === null) return;
    if (!done) {
      before.current = ownHeight(item);
      wasDone.current = false;
      return;
    }
    if (wasDone.current) return;
    wasDone.current = true;
    if (before.current !== null) setKept({ height: before.current, width: item.getBoundingClientRect().width });
    const active = document.activeElement;
    if (focusInside.current && (active === null || active === document.body)) titleRef.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    const item = ref.current;
    if (item === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (!wasDone.current) before.current = ownHeight(item);
      else setKept((now) => (now !== null && Math.abs(item.getBoundingClientRect().width - now.width) > 0.5 ? null : now));
    });
    observer.observe(item);
    return () => observer.disconnect();
  }, []);

  return {
    ref,
    titleRef,
    minHeight: kept?.height,
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
 * its next step to a Done pill, in place and at the height it had. The check draws once when it's
 * done in view; it is drawn still when it was already done at load, or done before this row was
 * drawn (a list shown again).
 */
function Thing({ icon, title, held = false, detail, below, done = null, children }: ThingProps) {
  const { ref, titleRef, minHeight, onFocus, onBlur } = useTickInPlace(done !== null);
  const [drawnDone] = useState(done !== null);
  const ticked = done !== null && !done.atLoad && !drawnDone;
  return (
    <li ref={ref} className="cd-things__item" style={minHeight === undefined ? undefined : { minHeight }} onFocus={onFocus} onBlur={onBlur}>
      <span className="cd-things__icon">
        {done === null ? <Icon name={icon} size={16} /> : <Icon name="check" size={16} className={ticked ? 'cd-things__check cd-things__check--draws' : 'cd-things__check'} />}
      </span>
      <div className="cd-things__text">
        <h3 ref={titleRef} className="cd-things__item-title cd-type-control" tabIndex={-1}>
          {title}
          {held && done === null ? <StatusDot tone="held" /> : null}
        </h3>
        <p className={ticked ? 'cd-things__detail cd-things__detail--done cd-type-meta' : 'cd-things__detail cd-type-meta'}>
          {done === null ? detail : done.line}
        </p>
      </div>
      <div className="cd-things__action">
        {done === null ? (
          children
        ) : (
          // The done line already says it in words, so the pill isn't read twice.
          <span className={ticked ? 'cd-things__done cd-things__done--ticked' : 'cd-things__done'} aria-hidden="true">
            <Pill>
              <StatusDot tone="handled" />
              Done
            </Pill>
          </span>
        )}
      </div>
      {below && done === null ? <div className="cd-things__below">{below}</div> : null}
    </li>
  );
}

/**
 * "Try to break it": the ideas, one of which is copied for the public page, which then opens in a
 * new tab. The tab is opened without `noopener` (with it the browser hides whether the tab opened),
 * and this page cuts the new tab's link back to it. A browser that blocks the tab gets a link to
 * open it by hand; a clipboard that refuses leaves the idea selected to copy by hand.
 */
function BreakIt({ link, ownerName, done }: { link: string; ownerName: string; done: RowDone | null }) {
  const [showing, setShowing] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const ideaRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    if (pick?.outcome !== 'failed' || !ideaRef.current) return;
    window.getSelection()?.selectAllChildren(ideaRef.current);
  }, [pick]);

  const onPick = async (idea: string) => {
    setPick(null);
    try {
      await navigator.clipboard.writeText(idea);
    } catch {
      setPick({ idea, outcome: 'failed' });
      return;
    }
    const tab = window.open(link, '_blank');
    if (tab === null) {
      setPick({ idea, outcome: 'blocked' });
      return;
    }
    tab.opener = null;
    setPick({ idea, outcome: 'copied' });
  };

  const below = showing ? (
    <div className="cd-things__ideas">
      <SuggestionChips label="Ideas to try" suggestions={ATTACK_IDEAS} onPick={(idea) => void onPick(idea)} />
      {pick?.outcome === 'failed' ? (
        <>
          <p ref={ideaRef} className="cd-things__idea cd-type-meta">
            {pick.idea}
          </p>
          <Notice tone="error">Copy didn't work. The idea is selected, so copy it yourself.</Notice>
        </>
      ) : null}
      {pick?.outcome === 'copied' ? <Notice tone="info">Copied. Paste it into the chat.</Notice> : null}
      {pick?.outcome === 'blocked' ? (
        <Notice
          tone="info"
          action={
            <Button variant="secondary" href={link} external>
              Open your public page
            </Button>
          }
        >
          Copied. Paste it into the chat.
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
          Ask for a discount, another customer's address or <span data-copy="user">{ownerName}</span>'s home number. Safety shows what was
          refused and why.
        </>
      }
      below={below}
      done={done}
    >
      <Button
        variant="secondary"
        onClick={() => {
          setShowing(!showing);
          setPick(null);
        }}
      >
        {showing ? 'Hide ideas' : 'Show me ideas'}
      </Button>
    </Thing>
  );
}
