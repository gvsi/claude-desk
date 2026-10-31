import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Icon, Notice, StatusDot, SuggestionChips, TextLink, type IconName } from '../../ds/index.ts';
import { BREAK_IT_IDEAS, handOffBreakItIdea, type BreakItIdea } from '../../lib/breakItIdeas.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { VISION_PATHS } from '../../vision/data.ts';
import { customerLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, useToday } from '../useDesks.ts';
import { THINGS_TO_TRY } from './ideas.ts';

export interface ThingsToTryProps {
  /** The oldest held request, which "Answer a held request" waits for; null while nothing is held. */
  firstHeld: NeedsYouItem | null;
  /** "Open the request": brings the held request's card into view and focus. */
  onFocusRequest: () => void;
}

const [CHAT, BREAK, ANSWER, CREATE] = THINGS_TO_TRY;

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

/** The ideas' words, as the chips show them. */
const IDEA_TEXTS = BREAK_IT_IDEAS.map((idea) => idea.text);

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
 * Today's "Things to try": four ways into the demo, each with its next step, then a link to where
 * this is going, the labelled vision pages. The public page always opens in a new tab, never on
 * Today. "Hide this list" is remembered in this browser when it can be.
 */
export function ThingsToTry({ firstHeld, onFocusRequest }: ThingsToTryProps) {
  const { business, desk } = useOwnerDesk();
  const today = useToday(desk.desk_id);
  const navigate = useNavigate();
  const titleId = useId();
  const [hidden, setHidden] = useState(() => readLocal('thingsToTryHidden') === 'true');
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

  return (
    <section className="cd-things" aria-labelledby={titleId}>
      <div className="cd-things__head">
        <h2 id={titleId} className="cd-things__title cd-type-section">
          Things to try
        </h2>
        <p className="cd-things__caption cd-type-meta">About 10 minutes. No real customer sees any of it.</p>
        <div ref={toggleRef} className="cd-things__hide">
          <Button variant="ghost" onClick={() => setHiddenAndRemember(true)}>
            Hide this list
          </Button>
        </div>
      </div>
      <Card padding={16}>
        <ul className="cd-things__list">
          <Thing icon="conversations" title={CHAT.title} detail="Your public page opens in a new tab. Ask about a leak, a price or a time.">
            <Button variant="secondary" href={link} external>
              Open your public page
            </Button>
          </Thing>
          <BreakIt slug={desk.slug} deskId={desk.desk_id} ownerName={ownerName} />
          {firstHeld?.decision ? (
            <Thing icon="clock" title={ANSWER.title} held detail={heldLine(firstHeld.held_by)}>
              <Button variant="secondary" onClick={onFocusRequest}>
                Open the request
              </Button>
            </Thing>
          ) : null}
          <Thing icon="plus" title={CREATE.title} detail="Describe a business in a few sentences. Claude drafts the rules, and you confirm them.">
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
  /** The row's next step, at its right. */
  children: ReactNode;
}

function Thing({ icon, title, held = false, detail, below, children }: ThingProps) {
  return (
    <li className="cd-things__item">
      <span className="cd-things__icon">
        <Icon name={icon} size={16} />
      </span>
      <div className="cd-things__text">
        <h3 className="cd-things__item-title cd-type-control">
          {title}
          {held ? <StatusDot tone="held" /> : null}
        </h3>
        <p className="cd-things__detail cd-type-meta">{detail}</p>
      </div>
      <div className="cd-things__action">{children}</div>
      {below ? <div className="cd-things__below">{below}</div> : null}
    </li>
  );
}

/**
 * "Try to break it": the fixed ideas. A pick hands the idea to the public page through this
 * browser's storage (`handOffBreakItIdea`) and opens the page in a new tab with the hand-off's
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

function BreakIt({ slug, deskId, ownerName }: { slug: string; deskId: string; ownerName: string }) {
  const [showing, setShowing] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);

  const onPick = (text: string) => {
    const idea = BREAK_IT_IDEAS.find((each) => each.text === text);
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
      <SuggestionChips label="Ideas to try" suggestions={IDEA_TEXTS} onPick={onPick} />
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
          Ask for a discount, another customer's address or <span data-copy="user">{ownerName}</span>'s home number. Safety shows what was
          refused and why.
        </>
      }
      below={below}
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
