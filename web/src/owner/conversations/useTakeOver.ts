/**
 * The owner's controls for one chat: take it over, hand it back, resume Claude after the breaker
 * paused it, write to the visitor in their own words, and whisper to Claude.
 *
 * Each change of who answers posts the generation the owner last read, so it never acts on a chat
 * that has moved on since: the API answers that with a 409, and the chat is read again before the
 * owner tries again. Nothing here is sent twice on its own. A write whose answer is lost may have
 * been applied, so the chat is read again first, and it is never called not done when it was. A
 * message is looked for only past the messages before it, so the same words sent earlier never
 * confirm it: after a read that missed one of those, the chat is read again before the next goes.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import type { SessionMode } from '../../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { OwnerTranscript, OwnerTranscriptItem } from '../../api/views.ts';

/** A 409 on any of these: the chat moved on while the owner was acting. */
export const CHANGED_WHILE_ACTING = 'This chat changed while you were acting. Check the latest and try again.';
/** The owner wrote to the visitor before taking the chat over. */
export const TAKE_OVER_FIRST = 'Take over first, then write to them.';
/** The reply check kept the owner's words from the visitor. */
export const SAY_STOPPED = "That wasn't sent: the reply check stopped it. Your words are back in the box to change.";
/** A message whose answer was lost, and which a read of the chat didn't show. */
export const SEND_UNCONFIRMED = "We couldn't confirm that went through. Check the chat before you send it again.";

/** The owner's reads of one chat. Query keys start with the route key. */
export const conversationKey = (sessionId: string) => ['conversation', sessionId] as const;

type ModeRoute = 'takeover' | 'handback' | 'resume';
type MessageKind = 'say' | 'whisper';

export interface UseTakeOver {
  takeOver(): void;
  handBack(): void;
  resume(): void;
  /** Writes to the visitor; resolves true once it went to them. */
  say(text: string): Promise<boolean>;
  /** Whispers to Claude; resolves true once it was kept. */
  whisper(text: string): Promise<boolean>;
  /** A change of who answers is on its way. */
  changing: boolean;
  /** Why the last change didn't happen, in the owner's words. */
  modeError: string | null;
  /** A message is on its way. */
  sending: boolean;
  /** Why the last message didn't go, or couldn't be confirmed. */
  messageError: string | null;
}

const maxN = (items: readonly OwnerTranscriptItem[]) => items.reduce((max, item) => Math.max(max, item.n), 0);

/** Whether `item`, past `after`, is the owner's `kind` message with `text`. */
function isMine(item: OwnerTranscriptItem, after: number, kind: MessageKind, text: string): boolean {
  if (item.n <= after) return false;
  if (kind === 'whisper') return item.kind === 'whisper' && item.text === text;
  return item.kind === 'delivered' && item.event?.type === 'message' && item.event.author === 'owner' && item.event.blocks.some((b) => b.text === text);
}

export function useTakeOver(sessionId: string): UseTakeOver {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  // Read synchronously, so a second press can't send twice.
  const busy = useRef({ mode: false, message: false });
  // A message went through, or may have, and the read after it failed: the chat as last read
  // doesn't show it, so its words could pass for a later message whose answer is lost.
  const unread = useRef(false);

  const lastRead = useCallback(() => queryClient.getQueryData<OwnerTranscript>(conversationKey(sessionId)), [queryClient, sessionId]);

  /** Reads the chat again, with everything that names its mode, and resolves to the chat as it stands (or null). */
  const reread = useCallback(async (): Promise<OwnerTranscript | null> => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['today'] });
    void queryClient.invalidateQueries({ queryKey: ['needsYou'] });
    await queryClient.invalidateQueries({ queryKey: conversationKey(sessionId) });
    const read = queryClient.getQueryState<OwnerTranscript>(conversationKey(sessionId));
    return read?.status === 'success' ? (read.data ?? null) : null;
  }, [queryClient, sessionId]);

  const change = useCallback(
    async (route: ModeRoute, to: SessionMode) => {
      const generation = lastRead()?.state.generation;
      if (generation === undefined || busy.current.mode) return;
      busy.current.mode = true;
      setChanging(true);
      setModeError(null);
      try {
        const state = await request(route, { params: { session_id: sessionId }, body: { generation } });
        queryClient.setQueryData<OwnerTranscript>(conversationKey(sessionId), (read) => (read ? { ...read, state } : read));
        await reread();
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'unauthorized') return;
        const now = await reread();
        if (err instanceof ApiError && err.kind === 'conflict') setModeError(CHANGED_WHILE_ACTING);
        // A lost answer that went through: the chat as read again shows it, and nothing went wrong.
        else if (!(isUncertain(err) && now?.state.mode === to)) setModeError(ownerErrorCopy(err));
      } finally {
        busy.current.mode = false;
        setChanging(false);
      }
    },
    [lastRead, queryClient, reread, sessionId],
  );

  /** Posts one message, looking for it past `after` in the chat as read again if its answer is lost. */
  const post = useCallback(
    async (kind: MessageKind, text: string, after: number): Promise<boolean> => {
      try {
        const out = await request('ownerMessage', { params: { session_id: sessionId }, body: { text, kind } });
        unread.current = (await reread()) === null;
        if (out.verdict !== null && out.verdict.ok !== true) {
          setMessageError(SAY_STOPPED);
          return false;
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'unauthorized') return false;
        const now = await reread();
        if (err instanceof ApiError && err.kind === 'conflict') {
          setMessageError(err.code === 'take_over_first' ? TAKE_OVER_FIRST : CHANGED_WHILE_ACTING);
          return false;
        }
        if (isUncertain(err)) {
          unread.current = now === null;
          // It may have gone through: only the chat as read again says so.
          if (now?.items.some((item) => isMine(item, after, kind, text)) === true) return true;
          setMessageError(SEND_UNCONFIRMED);
          return false;
        }
        setMessageError(ownerErrorCopy(err));
        return false;
      }
    },
    [reread, sessionId],
  );

  const send = useCallback(
    async (kind: MessageKind, text: string): Promise<boolean> => {
      if (busy.current.message) return false;
      busy.current.message = true;
      setSending(true);
      setMessageError(null);
      try {
        // The chat is read first when the last read missed a message that went through or may
        // have, so a lost answer below is looked for only past every earlier message. While it
        // can't be read, nothing goes.
        if (unread.current) {
          if ((await reread()) === null) {
            setMessageError(ownerErrorCopy(queryClient.getQueryState(conversationKey(sessionId))?.error));
            return false;
          }
          unread.current = false;
        }
        return await post(kind, text, maxN(lastRead()?.items ?? []));
      } finally {
        busy.current.message = false;
        setSending(false);
      }
    },
    [lastRead, post, queryClient, reread, sessionId],
  );

  return {
    takeOver: () => void change('takeover', 'owner'),
    handBack: () => void change('handback', 'ai'),
    resume: () => void change('resume', 'ai'),
    say: (text) => send('say', text),
    whisper: (text) => send('whisper', text),
    changing,
    modeError,
    sending,
    messageError,
  };
}
