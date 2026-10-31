/**
 * Ask Claude: the owner's conversation about rules, in a panel beside the page (`AppShell`'s
 * `panel`; a modal sheet on a phone). The owner frame holds it (`useAskClaudeHost`), so the
 * conversation outlives the page that opened it until the owner leaves for another page, and any
 * page under a Desk opens it with `useAskClaude().ask(words)`: the Rules page and, later, a tool's
 * page. Each change Claude drafts is reviewed inline, and nothing applies until it is confirmed.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { DRAFT_FAILED, RuleChat, chatTurn, type ChatTurn } from './RuleChat.tsx';

/** What a page under a Desk can do with the panel. */
export interface AskClaude {
  /** Opens the panel, if it isn't open, with the owner's words, and asks Claude. */
  ask: (words: string) => void;
  /** The panel is open. */
  open: boolean;
  /** Closes the panel, focus back on what opened it. */
  close: () => void;
}

const AskClaudeContext = createContext<AskClaude | null>(null);

/** The panel's provider, which the owner frame puts around the page. */
export const AskClaudeProvider = AskClaudeContext.Provider;

/** Ask Claude for a page under a Desk. */
export function useAskClaude(): AskClaude {
  const value = useContext(AskClaudeContext);
  if (value === null) throw new Error('useAskClaude is only for pages under a Desk');
  return value;
}

/**
 * The panel's state for one Desk, for the owner frame: the value its pages get, and the panel to
 * pass to `AppShell` (null while closed). The owner's words go to Claude one at a time, in the
 * order sent. Closing the panel, or leaving for another page, ends the conversation.
 */
export function useAskClaudeHost(deskId: string, ownerName: string): { value: AskClaude; panel: ReactNode } {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(0);
  // What had focus when the panel opened, which it goes back to when the panel closes.
  const opener = useRef<HTMLElement | null>(null);
  // Each conversation's requests go out one after another; a closed conversation's answers go nowhere.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const conversation = useRef(0);
  const nextId = useRef(0);
  // The panel's composer takes focus when the panel opens.
  const panelRoot = useRef<HTMLDivElement>(null);
  const [focusComposer, setFocusComposer] = useState(false);

  const id = () => {
    nextId.current += 1;
    return nextId.current;
  };

  const ask = useCallback(
    (words: string) => {
      const text = words.trim();
      if (text === '') return;
      if (!open) {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
        setOpen(true);
        setFocusComposer(true);
      }
      const at = conversation.current;
      setTurns((now) => [...now, { id: id(), kind: 'owner', text }]);
      setWaiting((n) => n + 1);
      queue.current = queue.current.then(async () => {
        const answered = await chatTurn(deskId, text, queryClient).catch((): Awaited<ReturnType<typeof chatTurn>> => [
          { kind: 'notice', tone: 'error', line: DRAFT_FAILED },
        ]);
        if (conversation.current !== at) return;
        setTurns((now) => [...now, ...answered.map((turn) => ({ ...turn, id: id() }) as ChatTurn)]);
        setWaiting((n) => Math.max(0, n - 1));
      });
    },
    [deskId, open, queryClient],
  );

  const end = useCallback(() => {
    conversation.current += 1;
    setOpen(false);
    setTurns([]);
    setWaiting(0);
  }, []);

  const close = useCallback(() => {
    end();
    const back = opener.current;
    opener.current = null;
    // Once the panel is gone: beside the page nothing else returns focus.
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus();
    });
  }, [end]);

  // Another page ends the conversation; the page it opened from is gone.
  const shownAt = useRef(pathname);
  useLayoutEffect(() => {
    if (shownAt.current === pathname) return;
    shownAt.current = pathname;
    opener.current = null;
    end();
  }, [pathname, end]);

  useLayoutEffect(() => {
    if (!focusComposer) return;
    setFocusComposer(false);
    panelRoot.current?.querySelector<HTMLElement>('textarea')?.focus();
  }, [focusComposer]);

  const settle = useCallback((turnId: number, outcome: 'confirmed' | 'kept') => {
    setTurns((now) => now.map((turn) => (turn.id === turnId && turn.kind === 'claude' ? { ...turn, settled: outcome } : turn)));
  }, []);

  const value = useMemo(() => ({ ask, open, close }), [ask, open, close]);
  const panel = open ? (
    <RuleChat ref={panelRoot} deskId={deskId} ownerName={ownerName} turns={turns} busy={waiting > 0} onSend={ask} onClose={close} onSettled={settle} />
  ) : null;
  return { value, panel };
}
