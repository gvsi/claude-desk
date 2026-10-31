import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Icon, Notice, StatusDot, SuggestionChips, TextLink, type IconName } from '../../ds/index.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { VISION_PATHS } from '../../vision/data.ts';
import { customerLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, useToday } from '../useDesks.ts';
import { ATTACK_IDEAS, THINGS_TO_TRY } from './ideas.ts';

export interface ThingsToTryProps {
  /** The oldest held request, which "Answer a held request" waits for; null while nothing is held. */
  firstHeld: NeedsYouItem | null;
  /** "Open the request": brings the held request's card into view and focus. */
  onFocusRequest: () => void;
}

const [CHAT, BREAK, ANSWER, CREATE] = THINGS_TO_TRY;

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
          <BreakIt link={link} ownerName={ownerName} />
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
 * "Try to break it": the ideas, one of which is copied for the public page, which then opens in a
 * new tab. The tab is opened without `noopener` (with it the browser hides whether the tab opened),
 * and this page cuts the new tab's link back to it. A browser that blocks the tab gets a link to
 * open it by hand; a clipboard that refuses leaves the idea selected to copy by hand.
 */
function BreakIt({ link, ownerName }: { link: string; ownerName: string }) {
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
