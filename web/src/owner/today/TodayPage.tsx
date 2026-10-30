import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ownerErrorCopy } from '../../api/http.ts';
import { Greeting } from '../../ds/index.ts';
import { greetingFor } from '../../lib/format.ts';
import { useAnswer, type HeldItem } from '../approvals/useAnswer.ts';
import { ThingsToTry } from '../arrival/ThingsToTry.tsx';
import { publicLink } from '../customerLink.ts';
import { OwnerInbox } from '../inbox/OwnerInbox.tsx';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, heldOldestFirst, useNeedsYou, useToday } from '../useDesks.ts';
import { LiveNow } from './LiveNow.tsx';
import { NeedsYou, type CallbackItem, type ReadFailure } from './NeedsYou.tsx';
import { greetingPresence } from './presence.ts';
import { requestInHash } from './requestLink.ts';
import { SinceLastNight } from './SinceLastNight.tsx';
import { TodayAside } from './TodayAside.tsx';

import './Today.css';

/** What the copy button's press did, read out to screen readers. */
type LinkCopy = 'idle' | 'copied' | 'failed';

const LINK_COPY_LINE: Record<Exclude<LinkCopy, 'idle'>, string> = {
  copied: 'Your Desk link is copied.',
  failed: "Copy didn't work. Select the link and copy it yourself.",
};

/**
 * `/app/:deskId/today`: the greeting with who is here now and the Desk's public link to copy,
 * "Things to try", then, in this order, "Needs you" and "Live now" when they have something, and
 * "Since last night" always; the right column has the public page a new tab away and the last 7
 * days. Today opens no visitor chat itself, and has no composer: changing a rule by asking Claude
 * lives on Rules. An address that names a held request (`#request-<id>`, as the Demo inbox links an
 * owner's alert) brings that request's card into view and focus.
 */
export function TodayPage() {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const today = useToday(deskId);
  const needsYou = useNeedsYou(deskId);
  const answers = useAnswer(deskId);
  const [linkCopy, setLinkCopy] = useState<LinkCopy>('idle');
  const cards = useRef(new Map<string, HTMLElement>());
  // Whether the Demo inbox's sheet is open, as it says once it has opened or closed.
  const [inboxOpen, setInboxOpen] = useState(false);

  const name = today.data?.greeting_name ?? firstName(business.owner_display_name);
  const link = publicLink(desk.slug);
  const live = today.data?.live ?? [];

  // Held requests oldest first, whatever order the API lists them in, with any whose answer is
  // still out or was lost kept in place; the ones answered here move to "Answered just now".
  const items = needsYou.data ?? [];
  const listed = heldOldestFirst(items);
  const listedIds = new Set(listed.map((item) => item.decision.decision_id));
  const kept = [...answers.kept.values()].filter((item) => !listedIds.has(item.decision.decision_id));
  const held: HeldItem[] = heldOldestFirst([...listed, ...kept]).filter((item) => !answers.answered.has(item.decision.decision_id));
  const callbacks = items.filter((item): item is CallbackItem => item.handoff != null);
  // When Needs you was last read, read on every render so each read renders Today again, even one
  // whose items are unchanged: after a conflict, it is what lets a request's answers back.
  const readAt = needsYou.dataUpdatedAt;
  const firstHeld = held[0] ?? null;
  // A failed read says so in Needs you, over whatever was read before, so it never looks as if
  // nothing needs the owner. It stays until a read works: React Query starts each read of a query
  // with nothing read yet as loading again and drops the error, so the section would blink out at
  // every poll, and while "Try again" reads.
  const [failure, setFailure] = useState<{ at: number; error: unknown } | null>(null);
  if (needsYou.error !== null && failure?.at !== needsYou.errorUpdatedAt) setFailure({ at: needsYou.errorUpdatedAt, error: needsYou.error });
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void needsYou.refetch().finally(() => setRetrying(false));
  };
  const readFailure: ReadFailure | null =
    failure !== null && needsYou.errorUpdatedAt > needsYou.dataUpdatedAt ? { line: ownerErrorCopy(failure.error), retrying, retry } : null;

  const registerCard = useCallback((decisionId: string, el: HTMLElement | null) => {
    if (el) cards.current.set(decisionId, el);
    else cards.current.delete(decisionId);
  }, []);
  // Focus brings the card into view too. A request with no card here is left alone.
  const focusCard = useCallback((decisionId: string) => cards.current.get(decisionId)?.focus(), []);
  const focusFirstHeld = () => {
    if (firstHeld !== null) focusCard(firstHeld.decision.decision_id);
  };

  // An arrival at `#request-<id>` lands on that card once, as "Open the request" does: once Needs
  // you has read, and once the Demo inbox's sheet, whose link it may be, has closed and handed focus
  // back to its button. A request that isn't here (answered, or another Desk's) leaves focus as it is.
  const requested = requestInHash(location.hash);
  const needsYouRead = needsYou.data !== undefined;
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (requested === null || inboxOpen || !needsYouRead || landed.current === location.key) return;
    landed.current = location.key;
    focusCard(requested);
  }, [requested, inboxOpen, needsYouRead, location.key, focusCard]);

  const copyLink = () => {
    setLinkCopy('idle');
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(
        () => setLinkCopy('copied'),
        () => setLinkCopy('failed'),
      );
  };

  return (
    <div className="cd-today" onClick={followInAppLinks(navigate)}>
      <div className="cd-today__main">
        <div className="cd-today__greeting">
          <Greeting
            text={`${greetingFor(new Date(), business.timezone)}, ${name}`}
            presence={today.data ? greetingPresence(live) : undefined}
            link={{ label: link, onCopy: copyLink }}
          />
          <p className="cd-sr-only" role="status">
            {linkCopy === 'idle' ? '' : LINK_COPY_LINE[linkCopy]}
          </p>
        </div>
        <ThingsToTry firstHeld={firstHeld} onFocusRequest={focusFirstHeld} />
        {held.length + callbacks.length + answers.answered.size > 0 || readFailure !== null ? (
          <NeedsYou
            held={held}
            callbacks={callbacks}
            answers={answers}
            readAt={readAt}
            registerCard={registerCard}
            readFailure={readFailure}
          />
        ) : null}
        {live.length > 0 ? <LiveNow live={live} /> : null}
        <SinceLastNight />
      </div>
      <TodayAside deskId={deskId} slug={desk.slug} inbox={<OwnerInbox deskId={deskId} timezone={business.timezone} onOpenChange={setInboxOpen} />} />
    </div>
  );
}
