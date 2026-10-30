/**
 * The owner's receipts: where the kernel decided, the owner reads why in their own words.
 *
 * The status event that reports a decision's decide outcome is the first one in the transcript for
 * its `decision_id`: a hold, a refusal, or an allowed action's one receipt, which the API sends
 * after it ran, so it usually reads `executed`. When that first receipt's state is one of
 * `OWNER_REASON_STATES`, it shows the decision's `reason_plain`, read once by its `decision_id`.
 * Until that read answers, or if it fails, it shows the event's `visitor_plain`.
 *
 * Every other receipt keeps the event's `visitor_plain` and reads nothing: a first receipt that
 * reads `failed`, `unknown` or `refused_at_execution` (the reason it was allowed would contradict
 * what happened), every later one for the same decision (the reason is written once, at decide
 * time, so a hold's words never follow it to its outcome), and every reply's check.
 */
import { useQuery } from '@tanstack/react-query';

import type { DecisionState, EvMessage, StatusEvent } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import { receiptFromEvent, type ReceiptView } from '../../ds/index.ts';

/** The first receipt states that report what the kernel decided, so they carry its owner line. */
export const OWNER_REASON_STATES = ['held', 'refused', 'executed', 'allowed'] as const;

const REASON_STATES: ReadonlySet<DecisionState> = new Set<DecisionState>(OWNER_REASON_STATES);

/** A decision as the owner reads it, by id: read once and kept, never polled. */
export const decisionKey = (decisionId: string) => ['decision', decisionId] as const;

/**
 * The receipt for `ev` on an owner screen. `first` is true for the first status row of its
 * `decision_id` in the transcript.
 */
export function useOwnerReceipt(ev: StatusEvent | EvMessage, first: boolean): ReceiptView {
  const view = receiptFromEvent(ev);
  const decisionId = ev.type === 'message' ? null : ev.decision_id;
  const wanted = decisionId !== null && first && ev.type !== 'message' && REASON_STATES.has(ev.state);
  const read = useQuery({
    queryKey: decisionKey(decisionId ?? ''),
    queryFn: () => request('decision', { params: { decision_id: decisionId ?? '' } }),
    enabled: wanted,
    // Written once, at decide time: one read is the answer for as long as the app runs.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const reason = read.data;
  if (!wanted || reason === undefined || reason.decision_id !== decisionId || reason.reason_plain.trim() === '') return view;
  return { ...view, plain: reason.reason_plain };
}
