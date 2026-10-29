import { useState } from 'react';

import { ownerErrorCopy } from '../../api/http.ts';
import { Button, Greeting, Notice } from '../../ds/index.ts';
import { greetingFor } from '../../lib/format.ts';
import { ThingsToTry } from '../arrival/ThingsToTry.tsx';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { firstName, heldOldestFirst, useNeedsYou, useToday } from '../useDesks.ts';
import { TodayAside } from './TodayAside.tsx';

import './Today.css';

/** What the copy button's press did, read out to screen readers. */
type LinkCopy = 'idle' | 'copied' | 'failed';

const LINK_COPY_LINE: Record<Exclude<LinkCopy, 'idle'>, string> = {
  copied: 'Your Desk link is copied.',
  failed: "Copy didn't work. Select the link and copy it yourself.",
};

/**
 * `/app/:deskId/today`: the greeting with the Desk's public link to copy, "Things to try", and the
 * right column with the public page a new tab away. Today opens no visitor chat itself, and has no
 * composer: changing a rule by asking Claude lives on Rules.
 */
export function TodayPage() {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const today = useToday(deskId);
  const needsYou = useNeedsYou(deskId);
  const [linkCopy, setLinkCopy] = useState<LinkCopy>('idle');

  const name = today.data?.greeting_name ?? firstName(business.owner_display_name);
  const firstHeld = heldOldestFirst(needsYou.data ?? [])[0] ?? null;
  const link = publicLink(desk.slug);

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
    <div className="cd-today">
      <div className="cd-today__main">
        <div className="cd-today__greeting">
          <Greeting text={`${greetingFor(new Date(), business.timezone)}, ${name}`} link={{ label: link, onCopy: copyLink }} />
          <p className="cd-sr-only" role="status">
            {linkCopy === 'idle' ? '' : LINK_COPY_LINE[linkCopy]}
          </p>
        </div>
        {today.isError ? (
          <Notice
            tone="error"
            action={
              <Button variant="secondary" onClick={() => void today.refetch()}>
                Try again
              </Button>
            }
          >
            {ownerErrorCopy(today.error)}
          </Notice>
        ) : null}
        {/* Task 5's Needs you puts the held request's card first, and "Open the request" will focus it. */}
        <ThingsToTry firstHeld={firstHeld} onFocusRequest={() => undefined} />
      </div>
      <TodayAside deskId={deskId} slug={desk.slug} />
    </div>
  );
}
