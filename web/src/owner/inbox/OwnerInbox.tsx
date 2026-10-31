/**
 * Today's Demo inbox: what Claude would have sent the owner by text or email (the kernel's alert
 * for each held request, the copy's codes and ledger checkpoints), in the design system's
 * `DemoInboxSheet` with `viewer="owner"`: a "Demo inbox" button with a count, which opens the
 * entries in a sheet at the right, each with when it came on the business's clock. An alert about a
 * held request links to that request's card on its own Desk's Today ("Open the request"): the inbox
 * is the whole copy's, so while the sheet is open each such request is read for the Desk it was
 * held on, and its alert links only once that read has answered.
 *
 * The copy's inbox is read once as Today opens, so the button counts what is there and the sheet
 * opens onto entries already read, never onto an inbox that only looks empty. It is read again as
 * the sheet opens and every few seconds while it is open, and not from the moment it closes. While
 * that first read is out, the button's place says the inbox is opening; if it fails, the inbox's
 * title says it couldn't be opened, with "Try again". A later read that fails says the same under
 * the sheet's button, and inside the sheet while it is open, where the page behind is out of reach,
 * so the entries read before never pass for current.
 */
import { focusManager, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, DemoInboxSheet, LoadingLine, Notice, SectionHeader, type DemoInboxItem } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { decisionQuery } from '../conversations/ownerReceipt.ts';
import { requestPath } from '../today/requestLink.ts';
import { useReadFailure } from '../useReadFailure.ts';

import './OwnerInbox.css';

export const OWNER_INBOX_KEY = ['ownerInbox'] as const;

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
  // network ask it, so one that comes while the close is still being drawn reads nothing.
  const [open, setOpen] = useState(false);
  const openNow = useRef(false);
  const openChanged = (next: boolean) => {
    openNow.current = next;
    setOpen(next);
    onOpenChange?.(next);
  };
  const inbox = useQuery({
    queryKey: OWNER_INBOX_KEY,
    queryFn: () => request('ownerInbox'),
    // Once as Today opens; after that, only while the sheet is open.
    refetchOnWindowFocus: () => openNow.current,
    refetchOnReconnect: () => openNow.current,
  });
  const failure = useReadFailure(inbox);

  // Read again as the sheet opens, so it shows what is there now.
  const { refetch, dataUpdatedAt, errorUpdatedAt } = inbox;
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  // Then every few seconds while it stays open and the tab is in view, counted again from each read's
  // answer, as React Query's `refetchInterval` counts. The poll is the sheet's own: `refetchInterval`
  // would stop only once Today had drawn the close, and a poll that came due in between would read.
  useEffect(() => {
    if (!open) return undefined;
    const poll = window.setInterval(() => {
      if (openNow.current && focusManager.isFocused()) void refetch({ cancelRefetch: false });
    }, pollMs('inbox'));
    return () => window.clearInterval(poll);
    // Each answer, read or failed, starts the count again.
  }, [open, refetch, dataUpdatedAt, errorUpdatedAt]);

  // The held requests the alerts name, each read for its Desk while the sheet is open. A read that
  // hasn't answered, failed, or names no action draws no link.
  const decisionIds = [...new Set((inbox.data ?? []).flatMap((entry) => (entry.decision_id ? [entry.decision_id] : [])))];
  const decisions = useQueries({ queries: decisionIds.map((id) => ({ ...decisionQuery(id), enabled: open })) });
  const deskOf = new Map<string, string>();
  decisions.forEach(({ data }, index) => {
    const id = decisionIds[index];
    if (id !== undefined && data?.decision_id === id && data.action) deskOf.set(id, data.action.desk_id);
  });
  const hrefFor = (decisionId: string | null | undefined): string | undefined => {
    const deskId = decisionId ? deskOf.get(decisionId) : undefined;
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
