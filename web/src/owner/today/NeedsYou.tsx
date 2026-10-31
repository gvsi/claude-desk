import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type Ref } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { NeedsYouItem } from '../../api/views.ts';
import { Button, Card, Notice, SectionHeader, StatusLabel } from '../../ds/index.ts';
import { callbackLine } from '../../lib/format.ts';
import { HeldRequest, type AnsweredFocus } from '../approvals/HeldRequest.tsx';
import type { HeldItem, UseAnswer } from '../approvals/useAnswer.ts';
import { conversationPath, type ConversationArrival } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { heldOldestFirst, needsYouKey, todayKey } from '../useDesks.ts';

/** An open handoff as Needs you lists it: a call-back request, or a conversation the handoff card handed over. */
export type CallbackItem = Extract<NeedsYouItem, { handoff: object }>;

/** Why the latest read of what needs the owner failed, in owner words, and a way to read it again. */
export interface ReadFailure {
  line: string;
  /** "Try again" is reading. */
  retrying: boolean;
  retry: () => void;
}

/** "1 needs you", "2 need you". */
function countLabel(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

export interface NeedsYouProps {
  /** Held requests still waiting for the owner, oldest first. */
  held: readonly HeldItem[];
  /** Open handoffs, in the order Needs you lists them. */
  callbacks: readonly CallbackItem[];
  answers: UseAnswer;
  /** When Needs you was last read (its `dataUpdatedAt`), which tells whether `held` shows a request as it stands since a conflict. */
  readAt: number;
  /** Called with each request's card as it mounts and unmounts, so "Open the request" and a request's address can focus it. */
  registerCard: (decisionId: string, el: HTMLElement | null) => void;
  /** `useAnsweredFocus` over `answers.answered`, kept by the page so a request's address can find its answered card. */
  answeredFocus: AnsweredFocus;
  /** The latest read failed: said first, over whatever was read before it. */
  readFailure: ReadFailure | null;
  /** Lets Today check whether the section survived a dismissal after React commits. */
  sectionRef: Ref<HTMLElement>;
  /** Dismisses the answer, then focuses the adjacent answered card or section after React commits. */
  onDismiss: (id: string, next: string | undefined) => void;
}

/**
 * Today's "Needs you": a failed read first, when the latest one failed; then one list of the held
 * requests and those answered here, oldest first, each an approval card answered in place, then
 * each open handoff. A request answered here stays where it was answered, with its final line and
 * Dismiss under it, until the owner dismisses it. The count counts only what is still open.
 */
export function NeedsYou({ held, callbacks, answers, readAt, registerCard, answeredFocus, readFailure, sectionRef, onDismiss }: NeedsYouProps) {
  const titleId = useId();
  const now = new Date();
  const open = held.length + callbacks.length;
  // Each request keeps its place, and its card, from held to answered.
  const requests = heldOldestFirst([...held, ...[...answers.answered.values()].map((entry) => entry.item)]);
  const { register: registerAnswered } = answeredFocus;
  const register = useCallback(
    (decisionId: string, el: HTMLElement | null) => {
      registerCard(decisionId, el);
      registerAnswered(decisionId, el);
    },
    [registerCard, registerAnswered],
  );

  const dismiss = (id: string) => {
    // Prefer the next answered card, else the one before. Today checks which section remains
    // after dismissal commits: a cached hold can reappear while the answer's refresh is still out.
    const ids = requests.map((item) => item.decision.decision_id).filter((decisionId) => answers.answered.has(decisionId));
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    onDismiss(id, next);
  };

  return (
    <section ref={sectionRef} className="cd-today__section" aria-labelledby={titleId} tabIndex={-1}>
      <SectionHeader id={titleId} title="Needs you" count={open > 0 ? { n: open, label: countLabel(open) } : undefined} />
      {readFailure !== null ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" busy={readFailure.retrying} onClick={readFailure.retry}>
              Try again
            </Button>
          }
        >
          {readFailure.line}
        </Notice>
      ) : null}
      {requests.length + callbacks.length > 0 ? (
        <ul className="cd-needs-you">
          {requests.map((item) => {
            const id = item.decision.decision_id;
            return (
              <li key={id} className="cd-needs-you__item">
                <HeldRequest item={item} answers={answers} readAt={readAt} now={now} registerCard={register}>
                  {answers.answered.has(id) ? (
                    <div className="cd-needs-you__dismiss">
                      <Button variant="ghost" onClick={() => dismiss(id)}>
                        Dismiss
                      </Button>
                    </div>
                  ) : undefined}
                </HeldRequest>
              </li>
            );
          })}
          {callbacks.map((item) => (
            <li key={item.handoff.handoff_id} className="cd-needs-you__item">
              <CallbackCard item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * A visitor who wants the owner, a way into the chat, and a way to close it. A call-back request
 * says their name, contact and reason as they typed them, and the callback they were promised; a
 * conversation the handoff card handed over says the Desk's reason alone, since no call back was
 * promised.
 */
function CallbackCard({ item }: { item: CallbackItem }) {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { handoff } = item;
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
    } catch (err) {
      if (err instanceof ApiError && (err.kind === 'not_found' || err.kind === 'conflict' || err.kind === 'unauthorized')) {
        // Nothing to say: the next read shows where it stands.
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
        {handoff.kind === 'card' ? null : <p className="cd-callback__when cd-type-meta">{callbackLine(handoff.callback_window, business.timezone)}</p>}
        {/* Only the pressed button spins; the other waits, its words shown, until its request settles. */}
        <div className="cd-callback__actions">
          <Button variant="secondary" busy={joining} waiting={closing} onClick={() => void join()}>
            Join the chat
          </Button>
          <Button variant="ghost" busy={closing} waiting={joining} onClick={() => void markDone()}>
            Mark done
          </Button>
        </div>
        {error !== null ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Card>
  );
}
