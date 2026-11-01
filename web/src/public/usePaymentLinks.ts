import { useEffect, useMemo, useRef, useState } from 'react';

import type { CardBlock, RenderedBlock } from '../api/contracts.ts';
import { request } from '../api/http.ts';
import type { ChatRow } from './chatReducer.ts';
import { CLOSED_LINK_STATES, paymentLinkClosed } from './paymentLinks.ts';

/** Only the same local checkout paths ReplyCard accepts may cause a read. */
function tokenOf(block: RenderedBlock): string | undefined {
  return block.kind === 'card' && block.template === 'payment_link'
    ? /^\/pay\/([A-Za-z0-9_-]+)$/.exec(block.href ?? '')?.[1]
    : undefined;
}

/** Chat-only action state; the stored transcript and every kernel-written word stay untouched. */
export function usePaymentLinks(rows: readonly ChatRow[]): (block: RenderedBlock) => RenderedBlock {
  const cards = useMemo(() => rows.flatMap(({ item }) => item.kind === 'message'
    ? item.ev.blocks.filter((block): block is CardBlock => block.kind === 'card') : []), [rows]);
  const cancellations = cards.filter((card) => card.template === 'link_cancelled');
  const refreshIds = rows.flatMap(({ item }) => item.kind === 'message' && item.ev.blocks.some(
    (block) => block.template === 'payment_confirmed' || block.template === 'link_cancelled',
  ) ? [item.ev.message_id] : []);
  const tokens = [...new Set(cards.filter((card) => !paymentLinkClosed(card, cancellations, undefined))
    .flatMap((card) => tokenOf(card) ?? []))];
  const [states, setStates] = useState<ReadonlyMap<string, unknown>>(new Map());
  const pending = useRef(new Map<string, Promise<void>>());
  const seen = useRef({ tokens: new Set<string>(), refreshIds: new Set<string>() });
  const active = useRef(false);
  const latest = useRef(tokens);
  latest.current = tokens;

  const read = (token: string) => {
    if (pending.current.has(token)) return;
    const work = request('paymentLink', { params: { token } })
      .then((link) => link.state, () => undefined)
      .then((state) => {
        // Remember confirmed closure for this mount. A later unavailable read cannot reopen it.
        if (active.current && typeof state === 'string' && CLOSED_LINK_STATES.includes(state)) {
          setStates((previous) => new Map(previous).set(token, state));
        }
      }).finally(() => pending.current.delete(token));
    pending.current.set(token, work);
  };

  useEffect(() => {
    active.current = true;
    let hidden = document.visibilityState === 'hidden';
    const visible = () => {
      if (document.visibilityState === 'hidden') hidden = true;
      else if (hidden) {
        hidden = false;
        latest.current.forEach(read);
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active.current = false;
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  // Row updates include typing, receipts, and the live animation settling. Only a new token or
  // a new closing card triggers reads; StrictMode's repeated effects share the in-flight work.
  useEffect(() => {
    const refresh = refreshIds.some((id) => !seen.current.refreshIds.has(id));
    tokens.filter((token) => refresh || !seen.current.tokens.has(token)).forEach(read);
    seen.current = { tokens: new Set(tokens), refreshIds: new Set(refreshIds) };
  });

  return (block) => {
    if (block.kind !== 'card' || block.template !== 'payment_link') return block;
    const token = tokenOf(block);
    return paymentLinkClosed(block, cancellations, token === undefined ? undefined : states.get(token))
      ? { ...block, href: null } : block;
  };
}
