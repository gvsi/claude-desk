import { queryOptions, useQueries } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';

import { pollMs } from '../../app/poll.ts';
import type { Answered, HeldItem, UseAnswer } from '../approvals/useAnswer.ts';
import { decisionQuery } from '../conversations/ownerReceipt.ts';

/**
 * Only requests drawn held on this visit can leave a closed card behind. A successful Needs you
 * read dropping one starts its decision read; keep the same card, with no answers, meanwhile.
 * These endings are presentation state, separate from answers actually given on Today.
 */
export function useClosedRequests(held: readonly HeldItem[], answers: UseAnswer, shown: boolean, readWorked: boolean) {
  const seen = useRef(new Map<string, HeldItem>());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  useLayoutEffect(() => {
    if (shown) for (const item of held) seen.current.set(item.decision.decision_id, item);
  });
  const listed = new Set(held.map((item) => item.decision.decision_id));
  const missing = [...seen.current.values()].filter(({ decision: { decision_id: id } }) =>
    !listed.has(id) && !answers.answered.has(id) && !answers.kept.has(id) && !dismissed.has(id),
  );
  const reads = useQueries({
    queries: missing.map((item) => queryOptions({
      ...decisionQuery(item.decision.decision_id),
      enabled: shown && readWorked,
      refetchOnMount: 'always',
      retryOnMount: true,
      // A previously cached held decision must be read again when the list drops it.
      staleTime: 0,
      refetchInterval: (query) => query.state.data === undefined || ['held', 'approved', 'unknown'].includes(query.state.data.state)
        ? pollMs('needsYou') : false,
    })),
  });
  const closed = new Map<string, Answered>();
  const reading: HeldItem[] = [];
  missing.forEach((item, index) => {
    const decision = reads[index]?.data;
    if (decision?.decision_id === item.decision.decision_id && decision.state !== 'held') {
      closed.set(decision.decision_id, { item, decision, card_diff: null });
    } else reading.push({ ...item, decision: { ...item.decision, answers: [] } });
  });
  const dismiss = (id: string) => setDismissed((previous) => new Set([...previous, id]));
  return { closed, reading, dismiss };
}
