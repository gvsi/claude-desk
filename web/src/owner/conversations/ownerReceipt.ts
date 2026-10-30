/**
 * The owner's receipts: where the kernel decided, the owner reads the decision's state and why, in
 * their own words.
 *
 * The status event that reports a decision's decide outcome is the first one in the transcript for
 * its `decision_id`: a hold, a refusal, or an allowed action's one receipt, which the API sends
 * after it ran, so it usually reads `executed`. When that first receipt's state is one of the
 * design system's `OWNER_REASON_STATES`, it carries the decision's `reason_plain`, read once by its
 * `decision_id`, as `MarginReceipt`'s `reason`: the receipt then reads "{state's words}. {reason}"
 * ("Automatic. …"), or "Held for you" alone with the request's card right under it. Until that
 * read answers, or if it fails, it carries no reason and shows the event's `visitor_plain`.
 *
 * Every other receipt keeps the event's `visitor_plain` and reads nothing: a first receipt that
 * reads `failed`, `unknown` or `refused_at_execution` (the reason it was allowed would contradict
 * what happened), every later one for the same decision (the reason is written once, at decide
 * time, so a hold's words never follow it to its outcome), and every reply's check.
 */
import { useQuery } from '@tanstack/react-query';

import type { DecisionState, EvMessage, StatusEvent } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import { OWNER_REASON_STATES, receiptFromEvent, type ReceiptView } from '../../ds/index.ts';

const REASON_STATES: ReadonlySet<DecisionState> = new Set<DecisionState>(OWNER_REASON_STATES);

/** A decision as the owner reads it, by id: read once and kept, never polled. */
export const decisionKey = (decisionId: string) => ['decision', decisionId] as const;

/** A receipt on an owner screen: `MarginReceipt`'s data, with the decision's reason where the kernel decided. */
export interface OwnerReceiptView extends ReceiptView {
  /** The decision's `reason_plain`, once read, on the receipt that reports what the kernel decided. */
  reason?: string;
}

/**
 * The receipt for `ev` on an owner screen. `first` is true for the first status row of its
 * `decision_id` in the transcript.
 */
export function useOwnerReceipt(ev: StatusEvent | EvMessage, first: boolean): OwnerReceiptView {
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
  const decision = read.data;
  if (!wanted || decision === undefined || decision.decision_id !== decisionId) return view;
  return { ...view, reason: decision.reason_plain };
}
