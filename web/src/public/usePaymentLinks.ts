import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { CardBlock, EvMessage, RenderedBlock } from '../api/contracts.ts';
import { request } from '../api/http.ts';
import { recordPayChat } from '../lib/payChats.ts';
import { CLOSED_LINK_STATES, paymentLinkClosed, type PaymentLinkMemory } from './paymentLinks.ts';

/** What the links' state is read from: a chat's messages, the visitor's or the owner's view of it, oldest first. */
export type LinkMessage = Pick<EvMessage, 'message_id' | 'blocks'>;

/** Only the same local checkout paths ReplyCard accepts may cause a read. */
function tokenOf(block: RenderedBlock): string | undefined {
  return block.kind === 'card' && block.template === 'payment_link'
    ? /^\/pay\/([A-Za-z0-9_-]+)$/.exec(block.href ?? '')?.[1]
    : undefined;
}

/**
 * Chat-only action state; the stored transcript and every kernel-written word stay untouched.
 * The visitor's chat and the owner's transcript both read it, so a link paid or cancelled loses
 * "Open payment page" in each alike.
 * With `chatPath` (the chat's own `/d/<slug>`, when the chat is the page), each payment link card
 * the chat shows notes its token, as a digest, against that path in this browser, so the paid
 * checkout can link back here (`payChats.ts`).
 */
export function usePaymentLinks(
  messages: readonly LinkMessage[],
  memory: PaymentLinkMemory,
  focusTarget?: RefObject<HTMLElement | null>,
  chatPath?: string,
): (block: RenderedBlock) => RenderedBlock {
  const cards = useMemo(() => messages.flatMap((ev) => ev.blocks.filter((block): block is CardBlock => block.kind === 'card')), [messages]);
  // Each link once while the chat is mounted, oldest card first, so the newest card is the newest entry.
  const recorded = useRef(new Set<string>());
  useEffect(() => {
    if (chatPath === undefined) return;
    for (const token of cards.flatMap((card) => tokenOf(card) ?? [])) {
      if (recorded.current.has(token)) continue;
      recorded.current.add(token);
      recordPayChat(token, chatPath);
    }
  }, [cards, chatPath]);
  const cancellations = cards.filter((card) => card.template === 'link_cancelled');
  const refreshIds = messages.flatMap((ev) => ev.blocks.some(
    (block) => block.template === 'payment_confirmed' || block.template === 'link_cancelled',
  ) ? [ev.message_id] : []);
  const [, redraw] = useState(0);
  const closed = (card: RenderedBlock) => paymentLinkClosed(card, cancellations, undefined) || memory.closed.has(tokenOf(card) ?? '');
  const tokens = [...new Set(cards.filter((card) => !closed(card))
    .flatMap((card) => tokenOf(card) ?? []))];
  const runtime = useMemo(() => ({
    pending: new Set<string>(),
    again: new Set<string>(),
    seen: { tokens: new Set<string>(), refreshIds: new Set<string>() },
    active: false,
    focused: null as HTMLAnchorElement | null,
    tokens: [] as string[],
  }), [memory]);
  runtime.tokens = tokens;

  // Removing a focused anchor leaves focus on body. Restore the reader's place after the DOM
  // update, without taking focus if they moved to another control while the read was pending.
  useLayoutEffect(() => {
    if (!runtime.focused || runtime.focused.isConnected) return;
    runtime.focused = null;
    if (document.activeElement === document.body) {
      const target = focusTarget?.current;
      (target?.querySelector('textarea') ?? target)?.focus({ preventScroll: true });
    }
  });

  const read = (token: string) => {
    if (memory.closed.has(token) || !runtime.tokens.includes(token)) return;
    if (runtime.pending.has(token)) {
      // Several triggers during one read coalesce into one follow-up if that answer stays open.
      runtime.again.add(token);
      return;
    }
    runtime.pending.add(token);
    void request('paymentLink', { params: { token } })
      .then((link) => link?.state)
      .then((state) => {
        // Terminal states survive a page remount in this chat; failures cannot reopen them.
        if (typeof state === 'string' && CLOSED_LINK_STATES.includes(state)) {
          memory.closed.add(token);
          if (runtime.active) redraw((previous) => previous + 1);
        }
      }).catch(() => undefined).finally(() => {
        runtime.pending.delete(token);
        if (runtime.again.delete(token) && runtime.active) read(token);
      });
  };

  useEffect(() => {
    runtime.active = true;
    const focused = () => {
      const element = document.activeElement;
      if (!(element instanceof HTMLAnchorElement)) { runtime.focused = null; return; }
      const token = /^\/pay\/([A-Za-z0-9_-]+)$/.exec(element.getAttribute('href') ?? '')?.[1];
      runtime.focused = token && runtime.tokens.includes(token) ? element : null;
    };
    const blurred = () => {
      const anchor = runtime.focused;
      // Removal also blurs an anchor. Keep that case for the layout effect, but forget an
      // action the visitor left while it was still present, including a move to body.
      queueMicrotask(() => {
        if (runtime.active && runtime.focused === anchor && anchor?.isConnected && document.activeElement !== anchor) {
          runtime.focused = null;
        }
      });
    };
    document.addEventListener('focusin', focused);
    document.addEventListener('focusout', blurred);
    let hidden = document.visibilityState === 'hidden';
    const visible = () => {
      if (document.visibilityState === 'hidden') hidden = true;
      else if (hidden) {
        hidden = false;
        const now = Date.now();
        if (memory.lastVisibilityRead !== null && now - memory.lastVisibilityRead < 30_000) return;
        if (runtime.tokens.length === 0) return;
        memory.lastVisibilityRead = now;
        runtime.tokens.forEach(read);
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      runtime.active = false;
      document.removeEventListener('focusin', focused);
      document.removeEventListener('focusout', blurred);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [memory, runtime]);

  // Row updates include typing, receipts, and the live animation settling. Only a new token or
  // a new closing card triggers reads; StrictMode's repeated effects share the in-flight work.
  useEffect(() => {
    const refresh = refreshIds.some((id) => !runtime.seen.refreshIds.has(id));
    tokens.filter((token) => refresh || !runtime.seen.tokens.has(token)).forEach(read);
    runtime.seen = { tokens: new Set(tokens), refreshIds: new Set(refreshIds) };
  });

  return (block) => {
    if (block.kind !== 'card' || block.template !== 'payment_link') return block;
    return closed(block) ? { ...block, href: null } : block;
  };
}
