import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Greeting } from '../../ds/index.ts';
import { greetingFor } from '../../lib/format.ts';
import { useAnswer, type HeldItem } from '../approvals/useAnswer.ts';
import { ThingsToTry } from '../arrival/ThingsToTry.tsx';
import { publicLink } from '../customerLink.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, heldOldestFirst, useNeedsYou, useToday } from '../useDesks.ts';
import { LiveNow } from './LiveNow.tsx';
import { NeedsYou, type CallbackItem } from './NeedsYou.tsx';
import { greetingPresence } from './presence.ts';
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
 * lives on Rules.
 */
export function TodayPage() {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const today = useToday(deskId);
  const needsYou = useNeedsYou(deskId);
  const answers = useAnswer(deskId);
  const [linkCopy, setLinkCopy] = useState<LinkCopy>('idle');
  const cards = useRef(new Map<string, HTMLElement>());

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
  const callbacks = items.filter((item): item is CallbackItem => item.handoff !== undefined);
  const firstHeld = held[0] ?? null;

  const registerCard = useCallback((decisionId: string, el: HTMLElement | null) => {
    if (el) cards.current.set(decisionId, el);
    else cards.current.delete(decisionId);
  }, []);
  const focusFirstHeld = () => {
    if (firstHeld !== null) cards.current.get(firstHeld.decision.decision_id)?.focus();
  };

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
        {held.length + callbacks.length + answers.answered.size > 0 ? (
          <NeedsYou held={held} callbacks={callbacks} answers={answers} registerCard={registerCard} />
        ) : null}
        {live.length > 0 ? <LiveNow live={live} /> : null}
        <SinceLastNight />
      </div>
      <TodayAside deskId={deskId} slug={desk.slug} />
    </div>
  );
}
