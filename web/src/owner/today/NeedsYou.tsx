import { useCallback, useId, type Ref } from 'react';

import { Button, Notice, SectionHeader } from '../../ds/index.ts';
import { HeldRequest, type AnsweredFocus } from '../approvals/HeldRequest.tsx';
import type { HeldItem, UseAnswer } from '../approvals/useAnswer.ts';
import { CallbackCard, type CallbackItem } from '../handoffs/CallbackCard.tsx';
import { heldOldestFirst } from '../useDesks.ts';

export type { CallbackItem } from '../handoffs/CallbackCard.tsx';

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
  // The chats with a request held and not yet answered here: their handoff cards leave Claude's note out.
  const heldChats = new Set(held.filter((item) => !answers.answered.has(item.decision.decision_id)).map((item) => item.decision.session_id));
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
              <CallbackCard item={item} showSummary={!heldChats.has(item.handoff.session_id)} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
