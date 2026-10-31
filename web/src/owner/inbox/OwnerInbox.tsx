/**
 * Today's Demo inbox: what Claude would have sent the owner by text or email (the kernel's alert
 * for each held request, the copy's codes and ledger checkpoints), in the design system's
 * `DemoInboxSheet` with `viewer="owner"`: a "Demo inbox" button with a count, which opens the
 * entries in a sheet at the right, each with when it came on the business's clock. An alert about a
 * held request links to that request's card on its own Desk's Today ("Open the request"): the inbox
 * is the whole copy's, so while the sheet is open each such request is read for the Desk it was
 * held on, and its alert links only once that read has answered.
 *
 * The copy's inbox is read with Today's other reads, as Today opens or just before, so the button
 * counts what is there and the sheet opens onto entries already read, never onto an inbox that only
 * looks empty. It is read again as the sheet opens and every few seconds while it is open, and
 * sends no new read from the moment it closes (a read already out finishes, with its one retry). If
 * Today opens while that first read is still out (it ran long), the button's place says the inbox
 * is opening; if it failed, Today opens on it, without sending it again, and the inbox's title says
 * it couldn't be opened, with "Try again". A later read that fails says the same under the sheet's
 * button, and inside the sheet while it is open, where the page behind is out of reach, so the
 * entries read before never pass for current.
 */
import { focusManager, hashKey, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { pollMs } from '../../app/poll.ts';
import { Button, DemoInboxSheet, LoadingLine, Notice, SectionHeader, type DemoInboxItem } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { decisionQuery } from '../conversations/ownerReceipt.ts';
import { requestPath } from '../today/requestLink.ts';
import { FRESH_MS, OWNER_INBOX_KEY, needsYouQuery, ownerInboxQuery } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';

import './OwnerInbox.css';

export interface OwnerInboxProps {
  /** The business's IANA time zone: each entry's time is on its clock. */
  timezone: string;
  /** Hears the sheet open (`true`) and close (`false`), after the sheet has handed focus back. */
  onOpenChange?: (open: boolean) => void;
}

export function OwnerInbox({ timezone, onOpenChange }: OwnerInboxProps) {
  const titleId = `${useId()}-title`;
  // Whether the sheet is open, as the sheet says each time it opens or closes. `openNow` changes the
  // moment it says so, before Today draws the change. The poll and a return to the tab or the
  // network ask it, so the inbox sends no new read from the moment it closes, not even one that
  // comes while the close is still being drawn (a read already out finishes, with its one retry).
  const [open, setOpen] = useState(false);
  const openNow = useRef(false);
  const openChanged = (next: boolean) => {
    openNow.current = next;
    setOpen(next);
    onOpenChange?.(next);
  };
  const inbox = useQuery({
    ...ownerInboxQuery(),
    // Today's opening reads it first (`useTodayOpening`); this reads it again only while the sheet is
    // open, where a return to the tab or the network reads however fresh the last read is.
    staleTime: FRESH_MS,
    // Today opens on what its first read found, a failure included, as it does with its other reads.
    retryOnMount: false,
    refetchOnWindowFocus: () => (openNow.current ? 'always' : false),
    refetchOnReconnect: () => (openNow.current ? 'always' : false),
  });
  const failure = useReadFailure(inbox);

  // Read again as the sheet opens, so it shows what is there now.
  const { refetch } = inbox;
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  // Then every few seconds while it stays open and the tab is in view, counted again from each change
  // to the read (it going out, its answer, read or failed), as React Query's `refetchInterval` counts.
  // The count starts again as the change happens, from the query cache, not once Today has drawn it,
  // so a poll can't come due just after an answer. The poll is the sheet's own: `refetchInterval`
  // would stop only once Today had drawn the close, and a poll that came due in between would read.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!open) return undefined;
    let poll: number | undefined;
    const startCount = () => {
      window.clearInterval(poll);
      poll = window.setInterval(() => {
        if (openNow.current && focusManager.isFocused()) void refetch({ cancelRefetch: false });
      }, pollMs('inbox'));
    };
    startCount();
    const inboxHash = hashKey(OWNER_INBOX_KEY);
    const stopHearing = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryHash === inboxHash) startCount();
    });
    return () => {
      stopHearing();
      window.clearInterval(poll);
    };
  }, [open, refetch, queryClient]);

  // The held requests the alerts name, each read for its Desk while the sheet is open. A read that
  // hasn't answered, failed, or names no action draws no link.
  const decisionIds = [...new Set((inbox.data ?? []).flatMap((entry) => (entry.decision_id ? [entry.decision_id] : [])))];
  const decisions = useQueries({ queries: decisionIds.map((id) => ({ ...decisionQuery(id), enabled: open })) });
  const deskOf = new Map<string, string>();
  decisions.forEach(({ data }, index) => {
    const id = decisionIds[index];
    if (id !== undefined && data?.decision_id === id && data.action) deskOf.set(id, data.action.desk_id);
  });
  // And each of those Desks' Needs you, Today's own read, read again as the sheet opens unless it
  // was just read: an alert links only while its request is still held there, waiting for the
  // owner. One answered since, here or anywhere, draws no link, since Today would have no card to
  // open; nor does one whose Desk's list hasn't been read yet.
  const heldDesks = [...new Set(deskOf.values())];
  const lists = useQueries({ queries: heldDesks.map((id) => ({ ...needsYouQuery(id), staleTime: FRESH_MS, enabled: open })) });
  const waiting = new Set<string>();
  lists.forEach(({ data }, index) => {
    for (const item of data ?? []) {
      const id = item.decision?.decision_id;
      if (id !== undefined && deskOf.get(id) === heldDesks[index]) waiting.add(id);
    }
  });
  const hrefFor = (decisionId: string | null | undefined): string | undefined => {
    const deskId = decisionId && waiting.has(decisionId) ? deskOf.get(decisionId) : undefined;
    return decisionId && deskId !== undefined ? requestPath(deskId, decisionId) : undefined;
  };

  const now = new Date();
  // Oldest first, as the sheet takes them; it shows the newest at the top.
  const items: DemoInboxItem[] = [...(inbox.data ?? [])]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((entry) => ({
      notice: { entry_id: entry.entry_id, to: entry.to, preview: '' },
      entry,
      time: formatWhen(entry.created_at, timezone, now),
      // The held request the kernel's alert names, by its id, never by anything the entry says.
      requestHref: hrefFor(entry.decision_id),
    }));

  // The latest read failed, whether or not one worked before.
  const failed =
    failure === null ? null : (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
            Try again
          </Button>
        }
      >
        {`Couldn't open your Demo inbox. ${failure.line}`}
      </Notice>
    );

  let content;
  if (inbox.data !== undefined) {
    // Every entry here is read whole, so nothing waits to open; a retry reads them all again. The
    // sheet stays first, so a failed read's line coming or going never closes it. The line shows
    // inside the open sheet, and here under its button for when it is closed.
    content = (
      <>
        <DemoInboxSheet
          viewer="owner"
          items={items}
          language="en"
          onRetry={() => void refetch()}
          notice={failed}
          onOpenChange={openChanged}
        />
        {failed}
      </>
    );
  } else if (failed !== null) {
    // Nothing read yet, so no sheet, which would say the inbox is empty: its title over the line.
    content = (
      <section className="cd-owner-inbox__failed" aria-labelledby={titleId}>
        <SectionHeader id={titleId} title="Demo inbox" />
        {failed}
      </section>
    );
  } else {
    content = <LoadingLine>Opening your Demo inbox</LoadingLine>;
  }
  return (
    <div className="cd-owner-inbox">
      {content}
    </div>
  );
}
