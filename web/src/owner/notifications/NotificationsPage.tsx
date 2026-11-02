/**
 * Notifications (REV-NOTIF), under Safety in the sidebar: what Claude would have sent the owner by
 * text or email (the kernel's alert for each held request, the copy's codes and ledger
 * checkpoints), newest first under the day each came on the business's clock, each row with its time.
 * It took the place of the demo bar's Demo inbox sheet, in the 760 px column Customers uses. An entry
 * the owner hadn't seen when the page opened keeps a dot for the visit, and its body in the primary
 * ink; one already seen has its body in the secondary ink. An alert about a held request links to
 * that request's card on its own
 * Desk's Today, the whole row a link with "Open the request" under the body, only while the
 * request still waits for the owner: the
 * notifications are the whole copy's, so each such request is read for the Desk it was held on,
 * and so is that Desk's Needs you. The alert links only while its request is still in that Needs
 * you, as read since the page opened by a read that worked. A request answered anywhere, on Today
 * too before its card is dismissed, shows its alert with no link.
 *
 * The notifications are read as the page opens and every few seconds while it is open, with each
 * linked Desk's Needs you that is no longer fresh; the page sends no new read once the owner leaves
 * it (a read already out finishes, with its one retry). What it shows counts as seen, so the
 * sidebar's count of unread ones goes as the page draws them. A read that fails, the first or a
 * later one, says so above the entries, with "Try again", never letting entries pass for current.
 */
import { focusManager, hashKey, useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { pollMs } from '../../app/poll.ts';
import type { DemoInboxEntry } from '../../api/contracts.ts';
import { Button, EmptyState, INBOX_COPY, Notice, PageHeader } from '../../ds/index.ts';
import { formatClock, formatDate, localDate } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { decisionQuery } from '../conversations/ownerReceipt.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { requestPath } from '../today/requestLink.ts';
import { FRESH_MS, OWNER_INBOX_KEY, needsYouQuery } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { markSeen, seenIds } from './seen.ts';
import { useNotifications } from './useNotifications.ts';

import '../conversations/Conversations.css';
import './NotificationsPage.css';

const TITLE = 'Notifications';
const COPY = INBOX_COPY.en;
/** The empty state's title and line: the inbox's one empty line, split at its first full stop. */
const [EMPTY_TITLE = '', ...EMPTY_REST] = COPY.empty.split('. ');
const EMPTY_BODY = EMPTY_REST.join('. ');

/** The recipient the kernel writes for the owner: their own entries don't say who they went to. */
const OWNER_RECIPIENT = 'owner';

/** One row: its entry, its time, whether it was unread as the page opened, and its request's link. */
interface Row {
  entry: DemoInboxEntry;
  time: string;
  unread: boolean;
  requestHref: string | undefined;
}

/** The rows of one day on the business's clock: "Today", or the date, "Nov 1". */
interface Day {
  day: string;
  rows: Row[];
}

/** The rows newest first, under the day each came. */
function daysOf(rows: readonly Row[], timeZone: string, now: Date): Day[] {
  const today = localDate(now.toISOString(), timeZone);
  const sorted = [...rows].sort((a, b) => Date.parse(b.entry.created_at) - Date.parse(a.entry.created_at));
  const days: Day[] = [];
  for (const row of sorted) {
    const day = localDate(row.entry.created_at, timeZone) === today ? 'Today' : formatDate(row.entry.created_at, timeZone);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return days;
}

export function NotificationsPage() {
  const { business } = useOwnerDesk();
  const navigate = useNavigate();
  useDocumentTitle(inApp(TITLE));
  // When the page opened, less `FRESH_MS`: a Desk's Needs you read before then is too old to link from.
  const [openedAt] = useState(() => Date.now() - FRESH_MS);
  // What the owner had seen as the page opened: every other entry keeps its dot for this visit.
  const [seenAtOpen] = useState(seenIds);
  const inbox = useNotifications({ onPage: true });
  const failure = useReadFailure(inbox, { pausedRoute: 'ownerInbox' });

  // Read again as the page opens, so it shows what is there now.
  const { refetch } = inbox;
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Whether the page is still shown: false from the moment it goes, before its effects are cleaned
  // up, so a poll that comes due as the owner leaves reads nothing.
  const shown = useRef(true);
  useLayoutEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  // Then every few seconds while it stays open and the tab is in view, counted again from each change
  // to the read (it going out, its answer, read or failed), as React Query's `refetchInterval` counts.
  // The count starts again as the change happens, from the query cache, so a poll can't come due
  // just after an answer. Each poll also reads again the Needs you of each Desk the links read
  // (below) that is no longer fresh. Today's own Desk's, which Today polls more often, always is.
  const queryClient = useQueryClient();
  const linkedDesks = useRef<readonly string[]>([]);
  useEffect(() => {
    let poll: number | undefined;
    const startCount = () => {
      window.clearInterval(poll);
      poll = window.setInterval(() => {
        if (!shown.current || !focusManager.isFocused()) return;
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
  }, [refetch, queryClient]);

  // The held requests the alerts name, each read for its Desk. A read that hasn't answered, failed,
  // or names no action draws no link.
  const decisionIds = [...new Set((inbox.data ?? []).flatMap((entry) => (entry.decision_id ? [entry.decision_id] : [])))];
  const decisions = useQueries({ queries: decisionIds.map((id) => decisionQuery(id)) });
  const deskOf = new Map<string, string>();
  decisions.forEach(({ data }, index) => {
    const id = decisionIds[index];
    if (id !== undefined && data?.decision_id === id && data.action) deskOf.set(id, data.action.desk_id);
  });
  // And each of those Desks' Needs you, Today's own read: read as the page opens unless it is
  // fresh, then on the page's poll once it no longer is. An alert links only while its request is
  // still in that list, as read since the page opened (or within `FRESH_MS` before) by a read that
  // was the latest and worked. A request answered since, anywhere (on Today too, before its card
  // is dismissed), draws no link, since it no longer waits for the owner; nor does one whose list
  // hasn't been read since the page opened, or whose latest read failed, which may be out of date.
  const heldDesks = [...new Set(deskOf.values())];
  useEffect(() => {
    linkedDesks.current = heldDesks;
  });
  const lists = useQueries({ queries: heldDesks.map((id) => ({ ...needsYouQuery(id), staleTime: FRESH_MS })) });
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

  // What the page shows counts as seen, so the sidebar's count of unread ones goes, before the
  // browser paints the frame that shows them: the count never shows an entry the page is showing.
  const shownIds = (inbox.data ?? []).map((entry) => entry.entry_id).join(' ');
  useLayoutEffect(() => {
    if (inbox.data !== undefined) markSeen(inbox.data.map((entry) => entry.entry_id));
    // `shownIds` stands for the entries: a read that brings the same ones marks nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds]);

  const rows: Row[] = (inbox.data ?? []).map((entry) => ({
    entry,
    time: formatClock(entry.created_at, business.timezone),
    unread: !seenAtOpen.has(entry.entry_id),
    // The held request the kernel's alert names, by its id, never by anything the entry says. Only
    // an alert links.
    requestHref: entry.kind === 'alert' ? hrefFor(entry.decision_id) : undefined,
  }));
  const days = daysOf(rows, business.timezone, new Date());

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
        {`Couldn't open your notifications. ${failure.line}`}
      </Notice>
    );

  // Nothing under the header until the first read settles, so the page never reads as empty while
  // it loads. A failed read's line stands alone when nothing was read, and above the days otherwise.
  let list = null;
  if (inbox.data !== undefined && rows.length === 0 && failed === null) list = <EmptyState title={EMPTY_TITLE} body={EMPTY_BODY} />;
  else if (rows.length > 0) {
    list = days.map(({ day, rows: dayRows }) => (
      <section key={day} className="cd-notifications__day" aria-label={day}>
        <h2 className="cd-conversations__day cd-type-caption">
          <span>{day}</span>
        </h2>
        <ul role="list" className="cd-notifications__list">
          {dayRows.map((row) => (
            <NotificationRow key={row.entry.entry_id} {...row} />
          ))}
        </ul>
      </section>
    ));
  }

  return (
    // A request's row goes through the router, so the app stays loaded.
    <div className="cd-notifications" onClick={followInAppLinks(navigate)}>
      <PageHeader title={TITLE} subtitle={COPY.ownerSubtitle} />
      <div className="cd-notifications__body" aria-live="polite">
        {failed}
        {list}
      </div>
    </div>
  );
}

/**
 * One notification: a dot while it was unread as the page opened, what kind it is (with who it went
 * to, unless the owner), its body word for word, and the time at the right. An alert whose request
 * still waits is a link as a whole, "Open the request" under its body.
 */
function NotificationRow({ entry, time, unread, requestHref }: Row) {
  const content = (
    <>
      <span className={unread ? 'cd-notifications__dot cd-notifications__dot--unread' : 'cd-notifications__dot'} aria-hidden="true" />
      <div className="cd-notifications__text">
        <p className="cd-notifications__kind cd-type-body">
          {unread ? <span className="cd-sr-only">Unread: </span> : null}
          {COPY.kinds[entry.kind]}
          {entry.to === OWNER_RECIPIENT ? null : <span className="cd-notifications__to cd-type-meta">{` · ${COPY.to} ${entry.to}`}</span>}
        </p>
        {/* A ledger checkpoint is a signed record, so it reads in the trace's monospace. */}
        <p className={`cd-notifications__entry ${entry.kind === 'head_checkpoint' ? 'cd-type-trace' : 'cd-type-body'}`}>{entry.body}</p>
        {requestHref === undefined ? null : (
          <p className="cd-notifications__request cd-type-meta">
            <span className="cd-text-link">{COPY.openRequest}</span>
          </p>
        )}
      </div>
      <span className="cd-notifications__time cd-type-meta">{time}</span>
    </>
  );
  return (
    <li className={unread ? 'cd-notifications__item cd-notifications__item--unread' : 'cd-notifications__item'}>
      {requestHref === undefined ? (
        <div className="cd-notifications__row">{content}</div>
      ) : (
        <a className="cd-notifications__row" href={requestHref}>
          {content}
        </a>
      )}
    </li>
  );
}
