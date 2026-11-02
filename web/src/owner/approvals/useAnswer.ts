/**
 * Answering a held request from an owner screen. An answer is sent once per click and never
 * retried on its own: a lost answer may have gone through, so it is never called "still held",
 * and asking again can't run the action twice (the API answers a repeat with a 409 and the
 * request's state as it then stands). A 409 without that state means the request changed while the
 * owner was looking: the answer is never sent again, since an approval is bound to the exact call
 * the owner saw. Needs you is read again first, and the screen offers answers only from that read.
 * What was answered stays on the screen with the line for its state as last read while the screen
 * is open, whatever Needs you reads next. An answer can settle while its action is still under way
 * (allowed and not yet run, or run with its outcome not yet known): its request is then read again
 * a few times, more slowly each time, and its card shows each read, until one is final. The reads
 * stop there, after the last of them (`ANSWER_REREAD_MS`), on Dismiss, and when the screen goes; a
 * read that fails is one of them and shows no error, since the answer went through.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApprovalAnswer, Decision, DecisionState, RuleCard } from '../../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { NeedsYouItem, RulesDraft } from '../../api/views.ts';
import { answerRereadMs, sleep } from '../../app/poll.ts';

/** A held request as Needs you lists it. */
export type HeldItem = Extract<NeedsYouItem, { decision: Decision }>;

/** A request the owner answered here: the item as it was held, its decision as last read, and the rule the answer proposes. */
export interface Answered {
  item: HeldItem;
  /** Final, or still under way while it is read again. */
  decision: Decision;
  /** An "always" answer's rule cards, drafted only when the owner asks to review them. */
  card_diff: RuleCard[] | null;
}

/** What the rule draft's review page gets in router state when Today opens it from an answer. */
export interface AnswerDraftState {
  cardDiff: RuleCard[];
  draft: RulesDraft;
}

/**
 * An answer the API turned back because the request changed while the owner was looking (a 409
 * without the request's state): the owner's line for it, shown above the request, and when
 * it came back. Only a read of Needs you that lands after `at` shows the request as it stands.
 */
export interface AnswerConflict {
  line: string;
  /** When the 409 came back (`Date.now()`), to compare with a read's `dataUpdatedAt`. */
  at: number;
}

export interface UseAnswer {
  /**
   * Sends `a` for `item`. Resolves once the answer settles the request, and rejects when it doesn't.
   * A request it leaves under way is read again after that, into `answered` and `latest`.
   */
  answer(item: HeldItem, a: ApprovalAnswer): Promise<void>;
  /** The requests whose answer is on its way, by `decision_id`. */
  pending: ReadonlySet<string>;
  /**
   * Why the last answer for a request didn't settle it, in the owner's words, for the card. A
   * conflict has its line in `conflictFor` instead.
   */
  errorFor(decisionId: string): string | undefined;
  /**
   * The request changed while the owner was looking, so the last answer was turned back and not
   * sent again. Its line stays above the request until the owner answers again or the request
   * settles; the answer's promise rejects only once Needs you has been read again (or that read
   * failed), and until a read lands after `at` the screen offers no answers for it.
   */
  conflictFor(decisionId: string): AnswerConflict | undefined;
  /** What was answered here, by `decision_id`, in the order it was answered, each as last read. */
  answered: ReadonlyMap<string, Answered>;
  /** The decision of the request answered here last, as last read, kept when its card is dismissed. */
  latest: Decision | null;
  /**
   * Held requests answered here whose answer hasn't settled (one in flight, or one whose answer was
   * lost), kept so their card stays to be asked again even when Needs you no longer lists them.
   */
  kept: ReadonlyMap<string, HeldItem>;
  /** Takes an answered request off the screen, and stops reading it again. */
  dismiss(decisionId: string): void;
}

const UNCERTAIN_LINE = "I couldn't confirm your answer went through. Try again; it can't run twice.";
const STILL_HELD_LINE = "That didn't go through, so the request is still held. Try again.";
const ABOVE_LIMIT_LINE = "That's above your limit for taking money without asking. Allow it this time, or change the limit on Rules.";
const NOT_OFFERED_LINE = "That answer isn't available for this request.";
const CHANGED_LINE = 'This request changed while you were answering. Reload to see where it stands.';

// States a decision can still leave: before an answer, or allowed and not yet run or confirmed.
const UNDER_WAY: ReadonlySet<DecisionState> = new Set<DecisionState>(['allowed', 'held', 'approved', 'unknown']);

/**
 * The 409 that says the request was answered already, with its state then: `already_resolved`.
 * The kernel's own 409 (`{error: "kernel", code}`) carries no decision and leaves the request held.
 */
function answeredStateOf(err: unknown, decisionId: string): Decision | null {
  if (!(err instanceof ApiError) || err.kind !== 'conflict' || err.code !== 'already_resolved') return null;
  return err.decision !== null && err.decision.decision_id === decisionId ? err.decision : null;
}

/**
 * A 409 without the request's state: the kernel's own conflict (`{error: "kernel", code}`,
 * the request still held but changed), or `already_resolved` without a decision to show.
 */
function isConflict(err: unknown): err is ApiError {
  return err instanceof ApiError && err.kind === 'conflict';
}

/** The owner's line for a conflict: the kernel's code in the owner's words, or, answered already without a state to show, that it moved on. */
function conflictLine(err: ApiError): string {
  return err.code === 'already_resolved' ? CHANGED_LINE : ownerErrorCopy(err);
}

/** The owner's line for any other answer that didn't settle the request. */
function lineFor(err: unknown, a: ApprovalAnswer): string {
  if (isUncertain(err)) return UNCERTAIN_LINE;
  if (err instanceof ApiError && err.status === 422) {
    // The kernel withholds "only for this person" once the money cap is below the amount, so only
    // a screen read before the cap was lowered can send it.
    return a === 'allow_person' ? ABOVE_LIMIT_LINE : NOT_OFFERED_LINE;
  }
  return STILL_HELD_LINE;
}

/**
 * The reads an answer can change: this Desk's Needs you first, then Today, record and attempts,
 * and any open conversation. Query keys start with their route key, then the Desk.
 */
function answerChanges(deskId: string): readonly [readonly string[], ...(readonly string[])[]] {
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
  const [latest, setLatest] = useState<Decision | null>(null);
  const [kept, setKept] = useState<ReadonlyMap<string, HeldItem>>(() => new Map());
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, AnswerConflict>>(() => new Map());
  // The answers on their way, read synchronously so a second click can't send twice.
  const sending = useRef(new Set<string>());
  // The requests read again because their answer left them under way, each stopped by its own
  // controller; and whether the screen is still open, so an answer that lands after it reads nothing.
  const rereads = useRef(new Map<string, AbortController>());
  const onScreen = useRef(false);

  useEffect(() => {
    onScreen.current = true;
    const running = rereads.current;
    return () => {
      onScreen.current = false;
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  const stopReading = useCallback((id: string) => {
    rereads.current.get(id)?.abort();
    rereads.current.delete(id);
  }, []);

  // Reads the request again on the schedule until a read is final, showing each read on its card.
  // A failed read is one of the tries, and the next waits as planned.
  const readUntilFinal = useCallback((id: string) => {
    const controller = new AbortController();
    const { signal } = controller;
    rereads.current.set(id, controller);
    void (async () => {
      for (const ms of answerRereadMs()) {
        await sleep(ms, signal);
        if (signal.aborted) return;
        let read: Decision;
        try {
          read = await request('decision', { params: { decision_id: id }, signal });
        } catch {
          // Cut off by Dismiss or the screen going: no wait follows.
          if (signal.aborted) return;
          continue;
        }
        if (signal.aborted) return;
        // An answered request never goes back to held: a read that says so is older than the answer,
        // and would offer the answers again.
        if (read.decision_id !== id || read.state === 'held') continue;
        setAnswered((current) => {
          const entry = current.get(id);
          return entry === undefined ? current : withEntry(current, id, { ...entry, decision: read });
        });
        setLatest((current) => (current?.decision_id === id ? read : current));
        if (!UNDER_WAY.has(read.state)) break;
      }
      if (rereads.current.get(id) === controller) rereads.current.delete(id);
    })();
  }, []);

  // Reads again everything the answer can change, and resolves once Needs you has been read (or
  // that read failed). An invalidation cancels a read already out, so the read it starts is the
  // first to land after it.
  const refresh = useCallback((): Promise<void> => {
    const [needsYou, ...others] = answerChanges(deskId);
    const read = queryClient.invalidateQueries({ queryKey: needsYou });
    for (const queryKey of others) void queryClient.invalidateQueries({ queryKey });
    return read;
  }, [deskId, queryClient]);

  const settle = useCallback(
    (item: HeldItem, decision: Decision, cardDiff: RuleCard[] | null) => {
      const id = item.decision.decision_id;
      setAnswered((current) => withEntry(current, id, { item, decision, card_diff: cardDiff }));
      setLatest(decision);
      setKept((current) => without(current, id));
      setErrors((current) => without(current, id));
      setConflicts((current) => without(current, id));
      stopReading(id);
      if (UNDER_WAY.has(decision.state) && onScreen.current) readUntilFinal(id);
      void refresh();
    },
    [readUntilFinal, refresh, stopReading],
  );

  const answer = useCallback(
    async (item: HeldItem, a: ApprovalAnswer): Promise<void> => {
      const id = item.decision.decision_id;
      if (sending.current.has(id)) return;
      sending.current.add(id);
      setPending((current) => new Set(current).add(id));
      setKept((current) => withEntry(current, id, item));
      setErrors((current) => without(current, id));
      setConflicts((current) => without(current, id));
      try {
        const out = await request('answer', { params: { decision_id: id }, body: { answer: a } });
        settle(item, out.decision, out.card_diff);
      } catch (err) {
        // Answered already (a repeat of an answer that went through, or one that came too late):
        // the request's state then is the answer, read again while it is under way.
        const already = answeredStateOf(err, id);
        if (already !== null) {
          settle(item, already, null);
          return;
        }
        // The request changed while the owner was looking: the answer isn't sent again. Its card
        // keeps waiting until Needs you has been read again, so it comes back showing the request as
        // it stands, and only where Needs you still lists it.
        if (isConflict(err)) {
          const conflict: AnswerConflict = { line: conflictLine(err), at: Date.now() };
          setConflicts((current) => withEntry(current, id, conflict));
          setKept((current) => without(current, id));
          await refresh();
          throw err;
        }
        setErrors((current) => withEntry(current, id, lineFor(err, a)));
        // A lost answer keeps its card to be asked again, even once Needs you no longer lists the
        // request; one that surely didn't go through shows wherever Needs you still lists it.
        if (!isUncertain(err)) setKept((current) => without(current, id));
        void refresh();
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
  const conflictFor = useCallback((decisionId: string) => conflicts.get(decisionId), [conflicts]);

  const dismiss = useCallback(
    (decisionId: string) => {
      stopReading(decisionId);
      setAnswered((current) => without(current, decisionId));
    },
    [stopReading],
  );

  return { answer, pending, errorFor, conflictFor, answered, latest, kept, dismiss };
}
