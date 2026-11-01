import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { Button, Greeting, NAV_LABELS, SkeletonScreen } from '../../ds/index.ts';
import { greetingFor } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { useAnsweredFocus } from '../approvals/HeldRequest.tsx';
import { useAnswer, type HeldItem } from '../approvals/useAnswer.ts';
import { ThingsToTry } from '../arrival/ThingsToTry.tsx';
import { customerLink, publicLink } from '../customerLink.ts';
import { useInboxOpen } from '../inbox/inboxOpen.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, heldOldestFirst, isLive, useNeedsYou, useToday, useTodayOpening } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { ContinueSetup } from './ContinueSetup.tsx';
import { LiveNow } from './LiveNow.tsx';
import { NeedsYou, type CallbackItem } from './NeedsYou.tsx';
import { greetingPresence } from './presence.ts';
import { requestInHash } from './requestLink.ts';
import { SinceLastNight } from './SinceLastNight.tsx';
import { TodayAside } from './TodayAside.tsx';
import { TodaySkeleton } from './TodaySkeleton.tsx';

import './Today.css';

export interface TodayPageProps {
  /**
   * Whether Today names the tab (default true). The still picture of Today behind the intro dialog
   * doesn't: there the dialog is the page, and the tab keeps the app's own name.
   */
  namesTheTab?: boolean;
}

/** What the copy button's press did, read out to screen readers. */
type LinkCopy = 'idle' | 'copied' | 'failed';

const LINK_COPY_LINE: Record<Exclude<LinkCopy, 'idle'>, string> = {
  copied: 'Your Desk link is copied.',
  failed: "Copy didn't work. Select the link and copy it yourself.",
};

/** How long the link's pill says "Copied" after a copy that worked. */
export const COPIED_FOR_MS = 1_600;

/**
 * `/app/:deskId/today`: a band across the page with the greeting, who is here now, the Desk's public
 * link to copy and "Chat as a customer" (the public page a new tab away), then "Not live yet" while
 * the Desk's setup hasn't gone live, and "Things to try"; under it two columns: in this order "Needs
 * you" and "Live now" when they have something, and "Since last night" always; at the right the last
 * 7 days. Today opens no visitor chat itself, and
 * has no composer: changing a rule by asking Claude lives on Rules. An address that names a held
 * request (`#request-<id>`, as the Demo inbox links an owner's alert) brings that request's card
 * into view and focus, once the demo bar's Demo inbox sheet, whose link it may be, has closed. Until what the page first shows is read, it holds its own shapes, so it
 * opens drawn however the owner came to it.
 */
export function TodayPage({ namesTheTab = true }: TodayPageProps) {
  const { business, desk, reachPlace } = useOwnerDesk();
  // The page's heading greets the owner, so the tab takes the sidebar's row.
  useDocumentTitle(namesTheTab ? inApp(NAV_LABELS.today) : null);
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const opening = useTodayOpening(deskId);
  // Back to Today restores the owner's place once the page has drawn its real content.
  useLayoutEffect(() => {
    if (!opening) reachPlace(location.key);
  }, [opening, reachPlace, location.key]);
  const today = useToday(deskId, { retryOnMount: false });
  const needsYou = useNeedsYou(deskId, { retryOnMount: false });
  const answers = useAnswer(deskId);
  // An answered card stays where it was answered, and focus that fell to the page follows it.
  const answeredFocus = useAnsweredFocus(answers.answered);
  const [linkCopy, setLinkCopy] = useState<LinkCopy>('idle');
  // The pill says "Copied" while this is set: a count of the copies that worked since it last cleared,
  // so each one starts the COPIED_FOR_MS wait again. A failed copy clears it; leaving Today ends the wait.
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    if (copied === null) return undefined;
    const timer = window.setTimeout(() => setCopied(null), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const cards = useRef(new Map<string, HTMLElement>());
  // Whether the demo bar's Demo inbox sheet is open, as the frame hears it.
  const inboxOpen = useInboxOpen();

  const name = today.data?.greeting_name ?? firstName(business.owner_display_name);
  // The Desk's setup while it hasn't gone live, as the copy's Desks name it; null once it is live,
  // and for a Desk listed without it (an API from before it).
  const setup = isLive(desk) ? null : desk.setup;
  const link = publicLink(desk.slug);
  const live = today.data?.live ?? [];

  // The held requests still open, oldest first, whatever order the API lists them in, with any whose
  // answer is still out or was lost kept in place. Needs you keeps the ones answered here in their
  // places among them, but they no longer count as open.
  const items = needsYou.data ?? [];
  // The chats with a handoff open, as Conversations reads them: Live now says "Wants you" for them.
  const handoffs = new Set(items.flatMap((item) => (item.handoff === null ? [] : [item.handoff.session_id])));
  const listed = heldOldestFirst(items);
  const listedIds = new Set(listed.map((item) => item.decision.decision_id));
  const kept = [...answers.kept.values()].filter((item) => !listedIds.has(item.decision.decision_id));
  const held: HeldItem[] = heldOldestFirst([...listed, ...kept]).filter((item) => !answers.answered.has(item.decision.decision_id));
  const callbacks = items.filter((item): item is CallbackItem => item.handoff != null);
  // When Needs you was last read, read on every render so each read renders Today again, even one
  // whose items are unchanged: after a conflict, it is what lets a request's answers back.
  const readAt = needsYou.dataUpdatedAt;
  const firstHeld = held[0] ?? null;
  // What the answers given here settled each request as: Things to try ticks "Answer a held request"
  // from them as soon as one lands, before the record is read again.
  const answeredDecisions = [...answers.answered.values()].map((a) => a.decision);
  // A failed read says so in Needs you, over whatever was read before, so it never looks as if
  // nothing needs the owner. It stays until a read works: React Query starts each read of a query
  // with nothing read yet as loading again and drops the error, so the section would blink out at
  // every poll, and while "Try again" reads.
  const readFailure = useReadFailure(needsYou, { pausedRoute: 'needsYou' });

  const registerCard = useCallback((decisionId: string, el: HTMLElement | null) => {
    if (el) cards.current.set(decisionId, el);
    else cards.current.delete(decisionId);
  }, []);
  // Focus brings the card into view too. A request with no card here is left alone.
  const focusCard = useCallback((decisionId: string) => cards.current.get(decisionId)?.focus(), []);
  // Decide from the committed sections, since dismissing before the answer's refresh lands can
  // expose a cached hold and keep Needs you mounted. Only move on once that section is gone.
  const needsYouSection = useRef<HTMLElement>(null);
  const liveNow = useRef<HTMLElement>(null);
  const sinceLastNight = useRef<HTMLElement>(null);
  const dismissedFocus = useRef<{ next: string | undefined } | null>(null);
  const dismissAnswer = (id: string, next: string | undefined) => {
    dismissedFocus.current = { next };
    answers.dismiss(id);
  };
  useLayoutEffect(() => {
    const dismissed = dismissedFocus.current;
    if (dismissed === null) return;
    dismissedFocus.current = null;
    if (needsYouSection.current !== null) {
      const card = dismissed.next === undefined ? undefined : answeredFocus.cardFor(dismissed.next);
      (card ?? needsYouSection.current).focus();
    } else {
      (liveNow.current ?? sinceLastNight.current)?.focus({ preventScroll: true });
    }
  });
  const focusFirstHeld = () => {
    if (firstHeld !== null) focusCard(firstHeld.decision.decision_id);
  };

  // An arrival at `#request-<id>` lands on that card once, as "Open the request" does: on the held
  // request's card, whether it is still held or was answered here. It lands once the latest
  // read of Needs you has worked (a list kept from before a failed read may be missing the request),
  // once the page has drawn its sections, and once the Demo inbox's sheet, whose link it may be, has
  // closed and handed focus back to its button. A request that isn't in the list gets one more read
  // of Needs you, as it may have been held since the last; if it still isn't here (answered
  // elsewhere, or another Desk's), focus stays as it is. Every change of address starts a new visit,
  // Back and Forward included, each with one landing.
  const [visit, setVisit] = useState<{ key: string; spent: boolean; rereadAfter: number | null }>({
    key: location.key,
    spent: false,
    rereadAfter: null,
  });
  if (visit.key !== location.key) setVisit({ key: location.key, spent: false, rereadAfter: null });
  const requested = visit.key === location.key && !visit.spent ? requestInHash(location.hash) : null;
  const readWorked = needsYou.data !== undefined && needsYou.errorUpdatedAt <= needsYou.dataUpdatedAt && !needsYou.isPaused;
  const { cardFor: answeredCardFor } = answeredFocus;
  const { refetch: readNeedsYou } = needsYou;
  useEffect(() => {
    if (opening || requested === null || inboxOpen || !readWorked) return;
    const key = location.key;
    const card = cards.current.get(requested) ?? answeredCardFor(requested);
    if (card === undefined && visit.rereadAfter === null) {
      setVisit((now) => (now.key === key ? { ...now, rereadAfter: readAt } : now));
      void readNeedsYou();
      return;
    }
    // Still waiting for that read.
    if (card === undefined && visit.rereadAfter !== null && readAt <= visit.rereadAfter) return;
    setVisit((now) => (now.key === key ? { ...now, spent: true } : now));
    card?.focus();
  }, [opening, requested, inboxOpen, readWorked, readAt, visit.rereadAfter, location.key, answeredCardFor, readNeedsYou]);
  // While it waits because Needs you can't be read, the owner's first pointer or key press spends
  // it: a read that works later doesn't pull focus from what they're doing by then. Listen in
  // the commit, before paint, so input on the new address cannot slip ahead of a passive effect.
  const readFailing = needsYou.errorUpdatedAt > needsYou.dataUpdatedAt || needsYou.isPaused;
  const waitsOnFailure = requested !== null && readFailing;
  useLayoutEffect(() => {
    if (!waitsOnFailure) return undefined;
    const key = location.key;
    const spend = () => setVisit((now) => (now.key === key ? { ...now, spent: true } : now));
    document.addEventListener('pointerdown', spend, true);
    document.addEventListener('keydown', spend, true);
    return () => {
      document.removeEventListener('pointerdown', spend, true);
      document.removeEventListener('keydown', spend, true);
    };
  }, [waitsOnFailure, location.key]);

  const copyLink = () => {
    setLinkCopy('idle');
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(
        () => {
          setLinkCopy('copied');
          setCopied((n) => (n ?? 0) + 1);
        },
        () => {
          setLinkCopy('failed');
          setCopied(null);
        },
      );
  };

  return (
    <>
      {opening ? <h1 className="cd-sr-only">Today</h1> : null}
      <SkeletonScreen loading={opening} status="Opening your Desk" skeleton={<TodaySkeleton />} className="cd-today-opening">
        <div className="cd-today" onClick={followInAppLinks(navigate)}>
          <div className="cd-today__band">
            <div className="cd-today__greeting">
              <Greeting
                text={`${greetingFor(new Date(), business.timezone)}, ${name}`}
                presence={today.data ? greetingPresence(live) : undefined}
                link={{ label: link, onCopy: copyLink, copied: copied !== null }}
                actions={
                  <Button variant="secondary" href={customerLink(desk.slug, deskId)} external>
                    Chat as a customer
                  </Button>
                }
              />
              <p className="cd-sr-only" role="status">
                {linkCopy === 'idle' ? '' : LINK_COPY_LINE[linkCopy]}
              </p>
            </div>
            {setup !== null ? (
              <ContinueSetup business={desk.business_name} interviewId={setup.interview_id} step={setup.step} answering={desk.answering} />
            ) : null}
            <ThingsToTry firstHeld={firstHeld} answered={answeredDecisions} latestAnswer={answers.latest} onFocusRequest={focusFirstHeld} />
          </div>
          <div className="cd-today__main">
            {/* Drawn while it lists something or a read has failed: its Dismiss sends focus on when neither is left. */}
            {held.length + callbacks.length + answers.answered.size > 0 || readFailure !== null ? (
              <NeedsYou
                held={held}
                callbacks={callbacks}
                answers={answers}
                readAt={readAt}
                registerCard={registerCard}
                answeredFocus={answeredFocus}
                readFailure={readFailure}
                sectionRef={needsYouSection}
                onDismiss={dismissAnswer}
              />
            ) : null}
            {live.length > 0 ? <LiveNow live={live} sectionRef={liveNow} openHandoffs={handoffs} /> : null}
            <SinceLastNight sectionRef={sinceLastNight} />
          </div>
          <TodayAside deskId={deskId} />
        </div>
      </SkeletonScreen>
    </>
  );
}
