/**
 * The owner app's Demo inbox, in the demo bar on every page of a Desk, just before Start over: what
 * Claude would have sent the owner by text or email (the kernel's alert for each held request, the
 * copy's codes and ledger checkpoints), in the design system's `DemoInboxSheet` with
 * `viewer="owner"`: a quiet "Demo inbox" button with a count, which opens the entries in a sheet at
 * the right, each with when it came on the business's clock. An alert about a held request links to
 * that request's card on its own Desk's Today ("Open the request") only while the request still
 * waits for the owner: the inbox is the whole copy's, so while the sheet is open each such request
 * is read for the Desk it was held on, and so is that Desk's Needs you. The alert links only while
 * its request is still in that Needs you, as read since the sheet opened by a read that worked. A
 * request answered anywhere, on Today too before its card is dismissed, shows its alert with no
 * link.
 *
 * The copy's inbox is read once as the bar first draws, and again as the sheet opens and every few
 * seconds while it is open, with each linked Desk's Needs you that is no longer fresh; it sends no
 * new read from the moment it closes (a read already out finishes, with its one retry), nor as the
 * owner moves between pages, where the bar stays. Until the first read settles the button isn't
 * drawn, so the sheet never opens onto an inbox that only looks empty. A read that fails, the first
 * or a later one, says so inside the sheet, with "Try again": the bar has no room for the line, and
 * the sheet opens onto it, never onto entries that pass for current.
 */
import { focusManager, hashKey, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { pollMs } from '../../app/poll.ts';
import { Button, DemoInboxSheet, Notice, ReviewerBarInboxSkeleton, type DemoInboxItem } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { decisionQuery } from '../conversations/ownerReceipt.ts';
import { followInAppLinks } from '../inAppLinks.ts';
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
  const navigate = useNavigate();
  // Whether the sheet is open, as the sheet says each time it opens or closes. `openNow` changes the
  // moment it says so, before Today draws the change. The poll and a return to the tab or the
  // network ask it, so the inbox sends no new read from the moment it closes, not even one that
  // comes while the close is still being drawn (a read already out finishes, with its one retry).
  const [open, setOpen] = useState(false);
  const openNow = useRef(false);
  // When the sheet last opened, less `FRESH_MS`: a Desk's Needs you read before then is too old to link from.
  const [openedAt, setOpenedAt] = useState(0);
  const openChanged = (next: boolean) => {
    openNow.current = next;
    if (next) setOpenedAt(Date.now() - FRESH_MS);
    setOpen(next);
    onOpenChange?.(next);
  };
  const inbox = useQuery({
    ...ownerInboxQuery(),
    // Read as the bar first draws; again only while the sheet is open, where a return to the tab or the
    // network reads however fresh the last read is.
    staleTime: FRESH_MS,
    // A failed read is read again from the sheet's "Try again", not each time the bar draws again.
    retryOnMount: false,
    refetchOnWindowFocus: () => (openNow.current ? 'always' : false),
    refetchOnReconnect: () => (openNow.current ? 'always' : false),
  });
  const failure = useReadFailure(inbox, { pausedRoute: 'ownerInbox' });

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
  // Each poll also reads again the Needs you of each Desk the links read (below) that is no longer
  // fresh. Today's own Desk's, which Today polls more often than that, always is, so it adds nothing.
  const queryClient = useQueryClient();
  const linkedDesks = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!open) return undefined;
    let poll: number | undefined;
    const startCount = () => {
      window.clearInterval(poll);
      poll = window.setInterval(() => {
        if (!openNow.current || !focusManager.isFocused()) return;
        void refetch({ cancelRefetch: false });
        for (const deskId of linkedDesks.current) void queryClient.prefetchQuery({ ...needsYouQuery(deskId), staleTime: FRESH_MS });
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
  // And each of those Desks' Needs you, Today's own read: read as the sheet opens unless it is
  // fresh, then on the sheet's poll once it no longer is. An alert links only while its request is
  // still in that list, as read since the sheet opened (or within `FRESH_MS` before) by a read that
  // was the latest and worked. A request answered since, anywhere (on Today too, before its card
  // is dismissed), draws no link, since it no longer waits for the owner; nor does one whose list
  // hasn't been read since the sheet opened, or whose latest read failed, which may be out of date.
  const heldDesks = [...new Set(deskOf.values())];
  useEffect(() => {
    linkedDesks.current = heldDesks;
  });
  const lists = useQueries({ queries: heldDesks.map((id) => ({ ...needsYouQuery(id), staleTime: FRESH_MS, enabled: open })) });
  const waiting = new Set<string>();
  lists.forEach(({ data, dataUpdatedAt, errorUpdatedAt }, index) => {
    if (errorUpdatedAt > dataUpdatedAt || dataUpdatedAt < openedAt) return;
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

  // Until the first read settles, the button's shape, as the bar's loading shapes draw it, so Start over
  // doesn't move when it lands. Every entry here is read whole, so nothing waits to open; a retry reads
  // them all again. A failed read's line shows inside the sheet, which stays open as it comes or goes;
  // with nothing read, the sheet holds the line alone.
  if (inbox.data === undefined && failed === null) return <ReviewerBarInboxSkeleton />;
  return (
    // "Open the request" goes through the router, so the app stays loaded.
    <div className="cd-owner-inbox" onClick={followInAppLinks(navigate)}>
      <DemoInboxSheet
        viewer="owner"
        quiet
        items={items}
        language="en"
        onRetry={() => void refetch()}
        notice={failed}
        onOpenChange={openChanged}
      />
    </div>
  );
}
