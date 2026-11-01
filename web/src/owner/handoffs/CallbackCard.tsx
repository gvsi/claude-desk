import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Notice, StatusLabel } from '../../ds/index.ts';
import { callbackLine } from '../../lib/format.ts';
import { conversationPath, type ConversationArrival } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { needsYouKey, todayKey } from '../useDesks.ts';

import './CallbackCard.css';

/** An open call-back request or card handoff, as Needs you lists it. */
export type CallbackItem = Extract<NeedsYouItem, { handoff: object }>;

/**
 * A visitor who wants the owner, a way into the chat, and a way to close it. A call-back request
 * says their name, contact and reason as they typed them, and the callback they were promised; a
 * conversation the handoff card handed over says the Desk's reason and the visitor's last words,
 * and promises no call back. Either says Claude's note on what the Desk stopped in the chat when the API
 * sends one, unless the chat has a request held (`showSummary`).
 */
interface CallbackCardProps {
  item: CallbackItem;
  /** Conversations already has take-over controls, so only Mark done is shown there. */
  showJoin?: boolean;
  /** The handoff closed: restore focus before the refreshed read removes its button. */
  onDone?: () => void;
  /**
   * False while the same chat has a request held: Claude's AI-written note never sits beside an
   * approval it could sway (owner decision, 2026-11-01).
   */
  showSummary?: boolean;
}

export function CallbackCard({ item, showJoin = true, onDone, showSummary = true }: CallbackCardProps) {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { handoff } = item;
  const summary = showSummary && item.claude_summary?.trim() ? item.claude_summary : null;
  const [joining, setJoining] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reread = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: needsYouKey(deskId) }), queryClient.invalidateQueries({ queryKey: todayKey(deskId) })]);

  // Reads the chat for its generation, takes it over at that generation, and opens it. A take-over
  // that fails still opens the chat, which then says why.
  const join = async () => {
    setJoining(true);
    setError(null);
    let notice: string | null = null;
    try {
      const chat = await request('conversation', { params: { session_id: handoff.session_id } });
      await request('takeover', { params: { session_id: handoff.session_id }, body: { generation: chat.state.generation } });
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        setJoining(false);
        return;
      }
      notice = ownerErrorCopy(err);
    }
    void reread();
    const state: ConversationArrival | undefined = notice === null ? undefined : { notice };
    void navigate(conversationPath(deskId, handoff.session_id), state === undefined ? undefined : { state });
  };

  // Closed already, or gone from the copy: Needs you reads again and says nothing went wrong.
  const markDone = async () => {
    setClosing(true);
    setError(null);
    try {
      await request('handoffDone', { params: { handoff_id: handoff.handoff_id } });
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && (err.kind === 'not_found' || err.kind === 'conflict' || err.kind === 'unauthorized')) {
        // Nothing to say: the next read shows where it stands.
        if (err.kind !== 'unauthorized') onDone?.();
      } else {
        setError(ownerErrorCopy(err));
      }
    }
    await reread().catch(() => undefined);
    setClosing(false);
  };

  return (
    <Card as="article" label="Wants you">
      <div className="cd-callback">
        <p className="cd-callback__top cd-type-caption">
          <StatusLabel tone="held">Wants you</StatusLabel>
        </p>
        <p className="cd-callback__reason cd-type-body" data-copy="user">
          {handoff.reason}
        </p>
        {/* The card's reason is the Desk's own: the visitor's last words, as a held request quotes them, say what it's about. */}
        {handoff.kind === 'card' && item.from_the_visitor !== null && item.from_the_visitor !== '' ? (
          <p className="cd-callback__context cd-type-meta">
            From the visitor: “<span data-copy="user">{item.from_the_visitor}</span>”
          </p>
        ) : null}
        {/* Claude's note on the chat's newest stopped attempt, for the owner alone and left out while the chat has a request held: plain text, never quoted or marked as the visitor's. */}
        {summary !== null ? <p className="cd-callback__context cd-type-meta">{`Claude's note on what the Desk stopped: ${summary}`}</p> : null}
        {/* A call back is promised only on a call-back request: one the API names so, or sends with no kind yet. */}
        {handoff.kind === undefined || handoff.kind === 'callback' ? (
          <p className="cd-callback__when cd-type-meta">{callbackLine(handoff.callback_window, business.timezone)}</p>
        ) : null}
        {/* Only the pressed button spins; the other waits, its words shown, until its request settles. */}
        <div className="cd-callback__actions">
          {showJoin ? (
            <Button variant="secondary" busy={joining} waiting={closing} onClick={() => void join()}>
              Join the chat
            </Button>
          ) : null}
          <Button variant="secondary" busy={closing} waiting={joining} onClick={() => void markDone()}>
            Mark done
          </Button>
        </div>
        {error !== null ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Card>
  );
}
