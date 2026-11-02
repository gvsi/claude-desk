/**
 * Ask Claude: the owner's conversation about rules, in a panel beside the page (`AppShell`'s
 * `panel`; a modal sheet on a phone). The owner frame holds it (`useAskClaudeHost`), so the
 * conversation outlives the page that opened it until the owner leaves for another page, and any
 * page under a Desk opens it with `useAskClaude().ask(words)`: the Rules page and, later, a tool's
 * page. Each change Claude drafts is reviewed inline, and nothing applies until it is confirmed.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { clickedControl } from '../../ds/index.ts';
import { DRAFT_FAILED, RuleChat, chatTurn, type ChatTurn } from './RuleChat.tsx';

/** What a page under a Desk can do with the panel. */
export interface AskClaude {
  /** Opens the panel, if it isn't open, with the owner's words, and asks Claude. */
  ask: (words: string) => void;
  /** The panel is open. */
  open: boolean;
  /**
   * An answer is on its way: a page's composer holds Send and Enter until it has come in, so the
   * next question waits there rather than behind it.
   */
  busy: boolean;
  /** Closes the panel, focus back on what opened it. */
  close: () => void;
}

/** Plan 02's limit on the owner's words to Claude, which the page's composer stops at. */
export const WORDS_MAX = 2000;

/**
 * Words past `WORDS_MAX` that reached the panel, from its own composer: they aren't sent, since the
 * API would only refuse them, and they stay in the conversation to shorten.
 */
export const WORDS_TOO_LONG = "That's over 2,000 characters. Shorten it and try again.";

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
  /** Claude's answer so far, while one is written. */
  const [growing, setGrowing] = useState<string | null>(null);
  /** The answer being written now: one stream at a time, closed with its conversation. */
  const stream = useRef<AbortController | null>(null);
  // What opened the panel, which focus goes back to when the panel closes: what had focus, or else
  // the control the click that opened it landed on. Safari focuses no button a click presses, so
  // after a click focus is still on the page's body.
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
        opener.current = active instanceof HTMLElement && active !== document.body ? active : clickedControl();
        setOpen(true);
        setFocusComposer(true);
      } else {
        // A page suggestion is disabled as this answer starts. Hand its focus on as a typed
        // question does; touch uses Close so it doesn't summon the phone keyboard.
        const touch = window.matchMedia('(pointer: coarse)').matches && !document.activeElement?.matches(':focus-visible');
        panelRoot.current?.querySelector<HTMLElement>(touch ? 'button[aria-label="Close"]' : 'textarea')?.focus();
      }
      const at = conversation.current;
      setTurns((now) => [...now, { id: id(), kind: 'owner', text }]);
      if (text.length > WORDS_MAX) {
        // Said after any answer still on its way, in the order sent. The panel's composer has no
        // limit of its own yet (the design system's AskClaudePanel takes no maxLength).
        queue.current = queue.current.then(() => {
          if (conversation.current === at) setTurns((now) => [...now, { id: id(), kind: 'notice', tone: 'error', line: WORDS_TOO_LONG }]);
        });
        return;
      }
      setWaiting((n) => n + 1);
      queue.current = queue.current.then(async () => {
        // A conversation closed before its turn came asks nothing more.
        if (conversation.current !== at) return;
        const controller = new AbortController();
        stream.current = controller;
        const answered = await chatTurn(deskId, text, queryClient, {
          onText: (words) => {
            if (conversation.current === at) setGrowing(words);
          },
          signal: controller.signal,
        }).catch((): Awaited<ReturnType<typeof chatTurn>> => [{ kind: 'notice', tone: 'error', line: DRAFT_FAILED }]);
        if (stream.current === controller) stream.current = null;
        if (conversation.current !== at) return;
        // The final answer takes the growing one's place in one step.
        setGrowing(null);
        setTurns((now) => [...now, ...answered.map((turn) => ({ ...turn, id: id() }) as ChatTurn)]);
        setWaiting((n) => Math.max(0, n - 1));
      });
    },
    [deskId, open, queryClient],
  );

  const end = useCallback(() => {
    conversation.current += 1;
    stream.current?.abort();
    stream.current = null;
    setOpen(false);
    setTurns([]);
    setWaiting(0);
    setGrowing(null);
  }, []);

  // Leaving the Desk ends the conversation: the answer being written closes, and nothing it had
  // queued is asked.
  useEffect(
    () => () => {
      conversation.current += 1;
      stream.current?.abort();
      stream.current = null;
    },
    [],
  );

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

  const busy = waiting > 0;
  const value = useMemo(() => ({ ask, open, busy, close }), [ask, open, busy, close]);
  const panel = open ? (
    <RuleChat
      ref={panelRoot}
      deskId={deskId}
      ownerName={ownerName}
      turns={turns}
      busy={busy}
      growing={growing}
      onSend={ask}
      onClose={close}
      onSettled={settle}
    />
  ) : null;
  return { value, panel };
}
