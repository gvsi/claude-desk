/**
 * Conversations: every chat with the Desk, newest first, grouped by day on the business's clock,
 * with the open one beside the list from 1024 px, as the signed boards draw it. Under that width
 * the list and an open conversation each have the page to themselves, and the conversation offers
 * a way back to the list. The list is polled.
 */
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { request } from '../../api/http.ts';
import type { ConversationSummary } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, ConceptFooter, ConversationListItem, EmptyState, Notice, TextLink } from '../../ds/index.ts';
import { conversationDay, formatListTime, type ConversationDay } from '../../lib/format.ts';
import { customerLink } from '../customerLink.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { RecordedHistoryLink } from '../today/SinceLastNight.tsx';
import { useReadFailure } from '../useReadFailure.ts';
import { ConversationDetail } from './ConversationDetail.tsx';
import { conversationPath, conversationStatus, whoLabel, type ConversationArrival } from './status.ts';

import './Conversations.css';

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
  const navigate = useNavigate();
  const location = useLocation();
  const titleId = useId();

  const list = useQuery({
    queryKey: conversationsKey(deskId),
    queryFn: () => request('conversations', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('list'),
  });
  const failure = useReadFailure(list);
  const now = new Date();
  const items = list.data ?? [];
  const groups = groupsOf(items, business.timezone, now);
  const open = sessionId === undefined ? undefined : items.find((s) => s.session_id === sessionId);
  const replayed = items.some((s) => s.replayed === true);

  let listBody;
  if (list.data === undefined && failure === null) {
    listBody = (
      <p className="cd-conversations__quiet cd-type-meta" role="status">
        Reading your conversations
      </p>
    );
  } else if (list.data !== undefined && items.length === 0) {
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
        <h2 className="cd-conversations__day cd-type-meta">{group.day}</h2>
        <ul className="cd-conversations__items">
          {group.items.map((s) => (
            <li key={s.session_id}>
              <ConversationListItem
                name={whoLabel(s)}
                time={formatListTime(s.last_activity, business.timezone, now)}
                status={conversationStatus(s, s.outcome_counts.held ?? 0)}
                href={conversationPath(deskId, s.session_id)}
                current={s.session_id === sessionId}
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
      <nav className="cd-conversations__list" aria-labelledby={titleId}>
        <h1 id={titleId} className="cd-conversations__title cd-type-page-title">
          Conversations
        </h1>
        {replayed ? (
          <p className="cd-conversations__caption">
            <RecordedHistoryLink deskId={deskId} />
          </p>
        ) : null}
        {failure !== null ? (
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
        ) : null}
        {listBody}
      </nav>
      <div className="cd-conversations__open">
        {sessionId === undefined ? (
          // Nothing to choose from yet: the list says how a conversation starts.
          items.length > 0 ? <p className="cd-conversations__quiet cd-conversations__pick cd-type-meta">Choose a conversation to read it.</p> : null
        ) : (
          <>
            <p className="cd-conversations__back cd-type-meta">
              <TextLink href={conversationsPath(deskId)}>All conversations</TextLink>
            </p>
            <ConversationDetail key={sessionId} sessionId={sessionId} summary={open} notice={arrivalNotice(location.state)} />
          </>
        )}
      </div>
      <footer className="cd-conversations__footer">
        <ConceptFooter />
      </footer>
    </div>
  );
}
