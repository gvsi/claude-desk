import { useQueryClient } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { Decision } from '../../api/contracts.ts';
import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { NeedsYouItem } from '../../api/views.ts';
import { ApprovalCard, Button, Card, Notice, SectionHeader, StatusLabel } from '../../ds/index.ts';
import { aboveMoneyCapCopy, callbackLine, relativeWait } from '../../lib/format.ts';
import type { AnswerDraftState, Answered, HeldItem, UseAnswer } from '../approvals/useAnswer.ts';
import { conversationPath, type ConversationArrival } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { needsYouKey, todayKey } from '../useDesks.ts';

/** An open callback as Needs you lists it. */
export type CallbackItem = Extract<NeedsYouItem, { handoff: object }>;

/** Why the latest read of what needs the owner failed, in owner words, and a way to read it again. */
export interface ReadFailure {
  line: string;
  /** "Try again" is reading. */
  retrying: boolean;
  retry: () => void;
}

const DRAFTED = 'Your answer also drafted a rule. Review it before it applies.';

/** "1 needs you", "2 need you". */
function countLabel(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

/** The request with nothing offered: what the owner sees until it is read again. */
function withNoAnswers(decision: Decision): Decision {
  return { ...decision, answers: [] };
}

/** What the approval card shows about a held request beyond the decision itself. */
function aboutTheRequest(item: HeldItem, now: Date) {
  const { session } = item;
  const name = session.display_name?.trim() ? session.display_name : undefined;
  return {
    heldBy: item.held_by ?? undefined,
    context:
      item.from_the_visitor !== null && item.from_the_visitor !== '' ? (
        <>
          From the visitor: “<span data-copy="user">{item.from_the_visitor}</span>”
        </>
      ) : undefined,
    waiting: `${session.kind === 'agent' ? 'Agent' : 'Web chat'}, ${relativeWait(item.held_at, now)}`,
    // The verified person's name on record, or the agent's own: "Only for {name}, always".
    personName: session.verified || session.kind === 'agent' ? name : undefined,
  };
}

export interface NeedsYouProps {
  /** Held requests still waiting for the owner, oldest first. */
  held: readonly HeldItem[];
  /** Open callbacks, in the order Needs you lists them. */
  callbacks: readonly CallbackItem[];
  answers: UseAnswer;
  /** When Needs you was last read (its `dataUpdatedAt`), which tells whether `held` shows a request as it stands since a conflict. */
  readAt: number;
  /** Called with each held request's card as it mounts and unmounts, so "Open the request" can focus it. */
  registerCard: (decisionId: string, el: HTMLElement | null) => void;
  /** The latest read failed: said first, over whatever was read before it. */
  readFailure: ReadFailure | null;
}

/**
 * Today's "Needs you": a failed read first, when the latest one failed; then each held request as
 * an approval card answered in place, then each open callback, then what was answered here with
 * its final line until the owner dismisses it.
 */
export function NeedsYou({ held, callbacks, answers, readAt, registerCard, readFailure }: NeedsYouProps) {
  const titleId = useId();
  const now = new Date();
  const open = held.length + callbacks.length;
  const answered = [...answers.answered.values()].reverse();

  // An answered card moves to "Answered just now"; focus that was in it, and fell to the page as
  // it moved, follows it there.
  const answeredCards = useRef(new Map<string, HTMLElement>());
  const seen = useRef(new Set(answers.answered.keys()));
  useLayoutEffect(() => {
    for (const id of answers.answered.keys()) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const active = document.activeElement;
      if (active === null || active === document.body) answeredCards.current.get(id)?.focus();
    }
  }, [answers.answered]);

  // After a conflict, the card shows the request as Needs you read it again. Focus that fell to the
  // page as its answers changed (the one pressed may no longer be offered) goes to the request, once.
  const heldCards = useRef(new Map<string, HTMLElement>());
  const conflictsSeen = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const item of held) {
      const id = item.decision.decision_id;
      const conflict = answers.conflictFor(id);
      const seen = conflict === undefined ? '' : `${id} ${conflict.at}`;
      if (conflict === undefined || answers.pending.has(id) || conflictsSeen.current.has(seen)) continue;
      conflictsSeen.current.add(seen);
      const active = document.activeElement;
      if (active === null || active === document.body) heldCards.current.get(id)?.focus();
    }
  });

  const dismiss = (id: string) => {
    // Focus goes to the next answered card, else the one before, else the section.
    const ids = answered.map((entry) => entry.decision.decision_id);
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    answers.dismiss(id);
    const target = next === undefined ? null : answeredCards.current.get(next);
    if (target) target.focus();
    else document.getElementById(titleId)?.closest<HTMLElement>('section')?.focus();
  };

  return (
    <section className="cd-today__section" aria-labelledby={titleId} tabIndex={-1}>
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
      {open > 0 ? (
        <ul className="cd-needs-you">
          {held.map((item) => {
            const id = item.decision.decision_id;
            const pending = answers.pending.has(id);
            // The request changed while the owner was looking: its line sits above it, and its
            // answers are the ones a read since then offers. Until one lands, it offers none.
            const conflict = answers.conflictFor(id);
            const asItStands = conflict === undefined || pending || readAt > conflict.at;
            return (
              <li key={id} className="cd-needs-you__item">
                {conflict !== undefined ? <Notice tone="error">{conflict.line}</Notice> : null}
                <div
                  ref={(el) => {
                    registerCard(id, el);
                    if (el) heldCards.current.set(id, el);
                    else heldCards.current.delete(id);
                  }}
                  className="cd-needs-you__card"
                  tabIndex={-1}
                >
                  <ApprovalCard
                    decision={asItStands ? item.decision : withNoAnswers(item.decision)}
                    {...aboutTheRequest(item, now)}
                    onAnswer={(a) => answers.answer(item, a)}
                    pending={pending}
                    error={answers.errorFor(id)}
                  />
                </div>
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
      {answered.length > 0 ? (
        <div className="cd-needs-you__answered">
          <h3 className="cd-needs-you__answered-title cd-type-control">Answered just now</h3>
          <ul className="cd-needs-you">
            {answered.map((entry) => {
              const id = entry.decision.decision_id;
              return (
                <li key={id} className="cd-needs-you__item">
                  <div
                    ref={(el) => {
                      if (el) answeredCards.current.set(id, el);
                      else answeredCards.current.delete(id);
                    }}
                    className="cd-needs-you__card"
                    tabIndex={-1}
                  >
                    <ApprovalCard decision={entry.decision} {...aboutTheRequest(entry.item, now)} onAnswer={() => undefined} />
                  </div>
                  {entry.card_diff !== null && entry.card_diff.length > 0 ? <DraftedRule entry={entry} /> : null}
                  <div className="cd-needs-you__dismiss">
                    <Button variant="ghost" onClick={() => dismiss(id)}>
                      Dismiss
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * An "always" answer's rule: the cards it proposes are drafted only when the owner asks to review
 * them, and nothing applies until they confirm the draft.
 */
function DraftedRule({ entry }: { entry: Answered }) {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ line: string; retry: boolean } | null>(null);
  const cardDiff = entry.card_diff ?? [];

  const review = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const draft = await request('draftRules', { params: { desk_id: deskId }, body: { add: cardDiff } });
      const state: AnswerDraftState = { cardDiff, draft };
      void navigate(`/app/${encodeURIComponent(deskId)}/rules/drafts/${draft.version}`, { state });
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // Above the money cap, trying again can't help until the limit is raised.
      if (err instanceof ApiError && err.code === 'above_money_cap') setFailure({ line: aboveMoneyCapCopy(err.capCents), retry: false });
      else setFailure({ line: ownerErrorCopy(err), retry: true });
    } finally {
      setBusy(false);
    }
  };

  const action = (label: string): ReactNode => (
    <Button variant="secondary" busy={busy} onClick={() => void review()}>
      {label}
    </Button>
  );
  return (
    <div className="cd-needs-you__rule">
      {failure === null ? (
        <Notice tone="info" action={action('Review the rule')}>
          {DRAFTED}
        </Notice>
      ) : (
        <Notice tone="error" action={failure.retry ? action('Try again') : undefined}>
          {failure.line}
        </Notice>
      )}
    </div>
  );
}

/**
 * A visitor who asked for the owner: their name, contact and reason as they typed them, the
 * callback they were promised, a way into the chat, and a way to close it.
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
        <p className="cd-callback__when cd-type-meta">{callbackLine(handoff.callback_window, business.timezone)}</p>
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
