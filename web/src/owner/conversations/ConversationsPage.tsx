/**
 * Conversations: every chat with the Desk, newest first, grouped by day on the business's clock,
 * with the open one beside the list from 1024 px, as the signed boards draw it. Under that width
 * the list and an open conversation each have the page to themselves, and the conversation offers
 * a way back to the list. The list is polled.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType, useParams } from 'react-router';

import { request } from '../../api/http.ts';
import type { ConversationSummary } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { AppShellOnly, Button, ConceptFooter, ConversationListItem, EmptyState, Notice, RecordedHistoryLink, SkeletonScreen, TextLink } from '../../ds/index.ts';
import { conversationDay, formatListTime, type ConversationDay } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { customerLink } from '../customerLink.ts';
import { followInAppLinks, returnThroughHistory } from '../inAppLinks.ts';
import { isStartingSampleDesk } from '../knowledge/sampleDesk.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { entriesPath } from '../today/SinceLastNight.tsx';
import { firstName, useDesks, useNeedsYou } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { ConversationDetail } from './ConversationDetail.tsx';
import { syncUnreadCount } from './useConversationRead.ts';
import { agentLine } from './copy.ts';
import { ConversationsSkeleton } from './ConversationsSkeleton.tsx';
import { CONVERSATIONS_SINGLE_COLUMN } from './layout.ts';
import { conversationPath, conversationListStatus, whoLabel, type ConversationArrival } from './status.ts';

import './Conversations.css';

const TITLE = 'Conversations';

/** A Desk's conversations, newest first. Query keys start with the route key. */
export const conversationsKey = (deskId: string) => ['conversations', deskId] as const;

/** The Desk's conversations list. */
export function conversationsPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}/conversations`;
}

function arrivalNotice(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const notice = (state as Partial<ConversationArrival>).notice;
  return typeof notice === 'string' && notice !== '' ? notice : null;
}

/** The demo visitor run the page that opened the chat started there, if it did. */
function arrivalRun(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const run = (state as Partial<ConversationArrival>).demoVisitorRun;
  return typeof run === 'string' && run !== '' ? run : null;
}

interface Group {
  day: ConversationDay;
  items: ConversationSummary[];
}

/** The conversations, newest first by their last activity, in their day's group. */
function groupsOf(items: readonly ConversationSummary[], timezone: string, now: Date): Group[] {
  const sorted = [...items].sort((a, b) => Date.parse(b.last_activity) - Date.parse(a.last_activity));
  const groups: Group[] = [];
  for (const item of sorted) {
    const day = conversationDay(item.last_activity, timezone, now);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export function ConversationsPage() {
  const { sessionId } = useParams();
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const queryClient = useQueryClient();
  const desks = useDesks(deskId, { passive: true });
  // The copy's starting sample Desk, the plumbing demo, as Knowledge tells it; not yet known while the Desks are read.
  const sampleDesk = desks.data !== undefined && isStartingSampleDesk(queryClient, desks.data, deskId);
  const recordedHistory = desks.data === undefined || sampleDesk;
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const titleId = useId();
  const listRef = useRef<HTMLElement>(null);
  const previousSession = useRef(sessionId);
  useLayoutEffect(() => {
    const previous = previousSession.current;
    previousSession.current = sessionId;
    if (sessionId !== undefined || previous === undefined || !window.matchMedia(CONVERSATIONS_SINGLE_COLUMN).matches) return;
    if (navigationType !== 'POP' && location.state?.fromChat !== true) return;
    // Back and All conversations return to the row; the shell owns focus for its navigation.
    const href = conversationPath(deskId, previous);
    const row = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].find((link) => link.getAttribute('href') === href);
    row?.focus();
  }, [sessionId, deskId, navigationType, location.state]);
  // The list's title names the tab, with a conversation open beside it or on its own too.
  useDocumentTitle(inApp(TITLE));

  const list = useQuery({
    queryKey: conversationsKey(deskId),
    queryFn: () => request('conversations', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('list'),
  });
  // Each read of the list carries its unread count to the sidebar, which every page shows.
  useEffect(() => {
    if (list.data !== undefined) syncUnreadCount(queryClient, deskId);
  }, [list.data, list.dataUpdatedAt, deskId, queryClient]);
  const needsYou = useNeedsYou(deskId);
  // The chats with an open handoff, from Needs you's last good read: a later read that fails leaves
  // them open, and with none yet, the rows keep their usual status.
  const handoffs = new Set((needsYou.data ?? []).flatMap((item) => (item.handoff === null ? [] : [item.handoff.session_id])));
  const failure = useReadFailure(list, { pausedRoute: 'conversations' });
  const needsFailure = useReadFailure(needsYou, { pausedRoute: 'needsYou' });
  const now = new Date();
  const items = list.data ?? [];
  const groups = groupsOf(items, business.timezone, now);
  const open = sessionId === undefined ? undefined : items.find((s) => s.session_id === sessionId);
  const replayed = items.some((s) => s.replayed === true);
  // Needs you supplies callback statuses, so both first reads settle before rows replace shapes.
  // Retained failures keep the list open while a reconnect or retry reads either part again.
  const listRead = (list.data !== undefined || failure !== null) && (needsYou.data !== undefined || needsFailure !== null);

  let listBody;
  if (list.data !== undefined && items.length === 0) {
    listBody = (
      <EmptyState
        title="No conversations yet"
        body="When someone writes to your Desk, it shows up here."
        action={
          <Button variant="secondary" href={customerLink(desk.slug, deskId)} external>
            Open your public page
          </Button>
        }
      />
    );
  } else {
    listBody = groups.map((group) => (
      <div key={group.day} className="cd-conversations__group">
        <h2 className="cd-conversations__day cd-type-caption"><span>{group.day}</span></h2>
        <ul className="cd-conversations__items">
          {group.items.map((s) => (
            <li key={s.session_id}>
              <ConversationListItem
                name={whoLabel(s)}
                time={formatListTime(s.last_activity, business.timezone, now)}
                status={conversationListStatus(s, s.outcome_counts.held ?? 0, handoffs.has(s.session_id), firstName(business.owner_display_name)) ?? undefined}
                href={conversationPath(deskId, s.session_id)}
                current={s.session_id === sessionId}
                unread={s.unread}
                recorded={s.replayed === true}
                demoVisitor={s.demo_visitor === true}
                quote={s.kind === 'visitor' && !s.owner_preview ? s.latest_visitor_text ?? undefined : undefined}
                line={s.kind === 'agent' ? agentLine(s, business.timezone) ?? undefined : undefined}
              />
            </li>
          ))}
        </ul>
      </div>
    ));
  }

  return (
    <div
      className={`cd-conversations${sessionId === undefined ? '' : ' cd-conversations--open'}`}
      onClick={followInAppLinks(navigate)}
    >
      <nav ref={listRef} className="cd-conversations__list" aria-labelledby={titleId}>
        <h1 id={titleId} className="cd-conversations__title cd-type-page-title">
          {TITLE}
        </h1>
        <SkeletonScreen
          loading={!listRead}
          status="Reading your conversations"
          skeleton={<ConversationsSkeleton withHeader={false} open={sessionId !== undefined} recordedHistory={recordedHistory} />}
          className="cd-conversations__region"
        >
          <div className="cd-conversations__under">
            {replayed ? (
              <p className="cd-conversations__caption">
                <RecordedHistoryLink href={entriesPath(deskId)} />
              </p>
            ) : null}
            {failure === null ? null : (
              <Notice
                tone="error"
                action={
                  <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
                    Try again
                  </Button>
                }
              >
                {failure.line}
              </Notice>
            )}
            {listBody}
          </div>
        </SkeletonScreen>
      </nav>
      <div className="cd-conversations__open">
        {sessionId === undefined ? (
          // Nothing to choose from yet: the list says how a conversation starts. With chats to
          // choose from, the pane says what opens in it (board REV-CNVW), centred in it.
          items.length > 0 ? (
            <div className="cd-conversations__empty">
              <EmptyState title="Choose a conversation to read it." body="Its chat opens here, where you can take over or whisper to Claude." />
            </div>
          ) : null
        ) : (
          <>
            {/* Under 1024 px the list, and its title, step aside for the conversation: the page keeps
                its one top heading here, out of sight, while the conversation opens and once it has. */}
            <h1 className="cd-sr-only cd-conversations__open-title">{TITLE}</h1>
            <p
              className="cd-conversations__back cd-type-meta"
              onClick={returnThroughHistory(navigate, conversationsPath(deskId), false, { state: { fromChat: true } })}
            >
              <TextLink href={conversationsPath(deskId)}>All conversations</TextLink>
            </p>
            <ConversationDetail
              key={sessionId}
              sessionId={sessionId}
              summary={open}
              listRead={listRead}
              notice={arrivalNotice(location.state)}
              sampleDesk={sampleDesk}
              demoVisitorRun={arrivalRun(location.state)}
            />
          </>
        )}
      </div>
      <AppShellOnly layout="compact">
        <footer className="cd-conversations__footer" data-owner-footer>
          <ConceptFooter />
        </footer>
      </AppShellOnly>
    </div>
  );
}
