/**
 * Answering a held request from an owner screen. An answer is sent once per click and never
 * retried on its own: a lost answer may have gone through, so it is never called "still held",
 * and asking again can't run the action twice (the API answers a repeat with a 409 and the
 * request's final state). What was answered stays on the screen with its final line while the
 * screen is open, whatever Needs you reads next.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import type { ApprovalAnswer, Decision, RuleCard } from '../../api/contracts.ts';
import { ApiError, isUncertain, request } from '../../api/http.ts';
import type { NeedsYouItem, RulesDraft } from '../../api/views.ts';

/** A held request as Needs you lists it. */
export type HeldItem = Extract<NeedsYouItem, { decision: Decision }>;

/** A request the owner answered here: the item as it was held, its final decision, and the rule the answer proposes. */
export interface Answered {
  item: HeldItem;
  decision: Decision;
  /** An "always" answer's rule cards, drafted only when the owner asks to review them. */
  card_diff: RuleCard[] | null;
}

/** What the rule draft's review page gets in router state when Today opens it from an answer. */
export interface AnswerDraftState {
  cardDiff: RuleCard[];
  draft: RulesDraft;
}

export interface UseAnswer {
  /** Sends `a` for `item`. Resolves once the request has its final state, and rejects when it doesn't. */
  answer(item: HeldItem, a: ApprovalAnswer): Promise<void>;
  /** The requests whose answer is on its way, by `decision_id`. */
  pending: ReadonlySet<string>;
  /** Why the last answer for a request didn't settle it, in the owner's words. */
  errorFor(decisionId: string): string | undefined;
  /** What was answered here, by `decision_id`, in the order it was answered. */
  answered: ReadonlyMap<string, Answered>;
  /**
   * Held requests answered here whose answer hasn't settled (one in flight, or one whose answer was
   * lost), kept so their card stays to be asked again even when Needs you no longer lists them.
   */
  kept: ReadonlyMap<string, HeldItem>;
  /** Takes an answered request off the screen. */
  dismiss(decisionId: string): void;
}

const UNCERTAIN_LINE = "I couldn't confirm your answer went through. Try again; it can't run twice.";
const STILL_HELD_LINE = "That didn't go through, so the request is still held. Try again.";
const ABOVE_LIMIT_LINE = "That's above your limit for taking money without asking. Allow it this time, or change the limit on Rules.";
const NOT_OFFERED_LINE = "That answer isn't available for this request.";
const CHANGED_LINE = 'This request changed while you were answering. Reload to see where it stands.';

/** The owner's line for an answer that didn't settle the request. */
function lineFor(err: unknown, a: ApprovalAnswer): string {
  if (isUncertain(err)) return UNCERTAIN_LINE;
  if (err instanceof ApiError && err.status === 422) {
    // The kernel withholds "only for this person" once the money cap is below the amount, so only
    // a screen read before the cap was lowered can send it.
    return a === 'allow_person' ? ABOVE_LIMIT_LINE : NOT_OFFERED_LINE;
  }
  // A conflict without the request's state says only that it moved on.
  if (err instanceof ApiError && err.kind === 'conflict') return CHANGED_LINE;
  return STILL_HELD_LINE;
}

/**
 * The reads an answer can change: this Desk's Needs you, Today, record and attempts, and any open
 * conversation. Query keys start with their route key, then the Desk.
 */
function answerChanges(deskId: string): readonly (readonly string[])[] {
  return [['needsYou', deskId], ['today', deskId], ['ledger', deskId], ['safety', deskId], ['conversation']];
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function without<V>(map: ReadonlyMap<string, V>, key: string): Map<string, V> {
  if (!map.has(key)) return map as Map<string, V>;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export function useAnswer(deskId: string): UseAnswer {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [answered, setAnswered] = useState<ReadonlyMap<string, Answered>>(() => new Map());
  const [kept, setKept] = useState<ReadonlyMap<string, HeldItem>>(() => new Map());
  // The answers on their way, read synchronously so a second click can't send twice.
  const sending = useRef(new Set<string>());

  const refresh = useCallback(() => {
    for (const queryKey of answerChanges(deskId)) void queryClient.invalidateQueries({ queryKey });
  }, [deskId, queryClient]);

  const settle = useCallback(
    (item: HeldItem, decision: Decision, cardDiff: RuleCard[] | null) => {
      const id = item.decision.decision_id;
      setAnswered((current) => withEntry(current, id, { item, decision, card_diff: cardDiff }));
      setKept((current) => without(current, id));
      setErrors((current) => without(current, id));
      refresh();
    },
    [refresh],
  );

  const answer = useCallback(
    async (item: HeldItem, a: ApprovalAnswer): Promise<void> => {
      const id = item.decision.decision_id;
      if (sending.current.has(id)) return;
      sending.current.add(id);
      setPending((current) => new Set(current).add(id));
      setKept((current) => withEntry(current, id, item));
      setErrors((current) => without(current, id));
      try {
        const out = await request('answer', { params: { decision_id: id }, body: { answer: a } });
        settle(item, out.decision, out.card_diff);
      } catch (err) {
        // Answered already (a repeat of an answer that went through, or one that came too late):
        // the request's final state is the answer.
        if (err instanceof ApiError && err.kind === 'conflict' && err.decision !== null && err.decision.decision_id === id) {
          settle(item, err.decision, null);
          return;
        }
        setErrors((current) => withEntry(current, id, lineFor(err, a)));
        // A lost answer keeps its card to be asked again, even once Needs you no longer lists the
        // request; one that surely didn't go through shows wherever Needs you still lists it.
        if (!isUncertain(err)) setKept((current) => without(current, id));
        refresh();
        throw err;
      } finally {
        sending.current.delete(id);
        setPending((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [refresh, settle],
  );

  const errorFor = useCallback((decisionId: string) => errors.get(decisionId), [errors]);

  const dismiss = useCallback((decisionId: string) => {
    setAnswered((current) => without(current, decisionId));
  }, []);

  return { answer, pending, errorFor, answered, kept, dismiss };
}
