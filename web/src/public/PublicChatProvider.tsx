/**
 * The visitor's chats, one per Desk slug, kept for as long as the app runs, so a chat survives its
 * page being unmounted and mounted again. Each chat loads in order (the public Desk, the session,
 * the stored conversation, then the event stream from the last seq it holds), sends what the
 * visitor writes and cancels held requests.
 *
 * Nothing here takes identity from the page: the API's HttpOnly cookie names the visitor's session,
 * and a 401 from any visitor route means that session is gone. A request whose answer is lost may
 * have been applied, so the chat reads the conversation before saying a message didn't send.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { PublicDesk, SessionState, SseEvent } from '../api/contracts.ts';
import { ApiError, isUncertain, request } from '../api/http.ts';
import { apiPath } from '../api/routes.ts';
import { openStream, type StreamState } from '../api/stream.ts';
import type { VisitorSession, VisitorTranscript } from '../api/views.ts';
import { browserLanguage, type BrowserLanguage } from '../lib/language.ts';
import { chatReducer, initialChatState, type ChatAction, type ChatState, type SendFailure } from './chatReducer.ts';

export type ChatStatus = 'loading' | 'ready' | 'not_found' | 'unavailable';

/** How long the chat waits before each reopen of a stream the server closed; after the last, it gives up. */
export const REOPEN_DELAYS_MS = [2_000, 5_000, 10_000] as const;

/** Every event a visitor's stream carries. */
const EVENT_TYPES: readonly SseEvent['type'][] = [
  'writing',
  'message',
  'turn_end',
  'receipt',
  'held',
  'resolved',
  'owner_joined',
  'owner_left',
  'demo_inbox',
  'error',
];

export interface VisitorChatSnapshot {
  /** The public Desk the chat loaded, or null until it has. */
  desk: PublicDesk | null;
  state: ChatState;
  session: SessionState | null;
  status: ChatStatus;
  /** The held request being cancelled, until its outcome arrives. */
  cancelling: string | null;
  /** The last cancel failed and wasn't applied. */
  cancelFailed: boolean;
}

export interface VisitorChatActions {
  send: (text: string) => void;
  /** Sends a failed message again ("Try again"). */
  resend: (id: string) => void;
  /** Loads the Desk again, or reopens a stream the chat gave up on. */
  retry: () => void;
  /** Starts a new chat after this one ended. */
  newChat: () => void;
  cancel: (decisionId: string) => void;
}

export type VisitorChatView = VisitorChatSnapshot & VisitorChatActions;

/**
 * The visitor's session with `slug`'s Desk: the browser's own when it has one, else a new one. With
 * `previewDeskId`, the owner's preview of that Desk, which the API grants only to the owner of its
 * copy; for anyone else it fails, and a plain chat opens instead.
 */
export async function ensureSession(slug: string, previewDeskId?: string): Promise<VisitorSession> {
  if (previewDeskId !== undefined && previewDeskId !== '') {
    try {
      return await request('openPreview', { params: { desk_id: previewDeskId } });
    } catch {
      // Not this owner's Desk, or no owner at all: a visitor's chat, as anyone gets.
    }
  }
  return request('openSession', { params: { slug } });
}

const sessionGone = (err: unknown) => err instanceof ApiError && err.kind === 'unauthorized';

function failureOf(err: unknown): SendFailure {
  if (!(err instanceof ApiError)) return 'not_sent';
  if (err.kind === 'unauthorized') return 'session';
  if (err.kind === 'rate_limited') return 'rate_limited';
  if (err.kind === 'unprocessable') return 'too_long';
  return 'not_sent';
}

const LOCAL_ID = 'local-';

class VisitorChat {
  private snapshot: VisitorChatSnapshot = {
    desk: null,
    state: initialChatState(),
    session: null,
    status: 'loading',
    cancelling: null,
    cancelFailed: false,
  };
  private readonly listeners = new Set<() => void>();
  /** Pages showing this chat; the stream is open only while there is one. */
  private users = 0;
  /** Bumped when in-flight loading and streaming must stop applying: a new chat, or nobody watching. */
  private epoch = 0;
  private loading = false;
  /** The session and its stored conversation are in. */
  private loaded = false;
  private stopStream: (() => void) | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopens = 0;
  /** The highest `n` in the conversation as last read: a lost message is looked for after it. */
  private knownN = 0;
  private nextId = 0;

  constructor(
    private readonly slug: string,
    private readonly previewDeskId: string | undefined,
    private readonly language: BrowserLanguage,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): VisitorChatSnapshot => this.snapshot;

  private set(patch: Partial<VisitorChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private dispatch(action: ChatAction): void {
    const state = chatReducer(this.snapshot.state, action);
    // A cancel is done once its hold has left the open ones.
    const { cancelling } = this.snapshot;
    this.set({ state, cancelling: cancelling !== null && state.openHolds.includes(cancelling) ? cancelling : null });
  }

  attach(): void {
    this.users += 1;
    if (this.users !== 1) return;
    if (this.loaded) this.startStream();
    else void this.load();
  }

  detach(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    this.epoch += 1;
    this.loading = false;
    this.stop();
  }

  private stop(): void {
    this.stopStream?.();
    this.stopStream = null;
    if (this.reopenTimer !== null) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
  }

  /** The Desk (once), then the session and its conversation, then the stream. */
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const epoch = this.epoch;
    this.set({ status: 'loading' });
    try {
      const desk =
        this.snapshot.desk ?? (await request('publicDesk', { params: { slug: this.slug }, query: { lang: this.language } }));
      if (epoch !== this.epoch) return;
      this.set({ desk });
      await this.open(epoch);
    } catch (err) {
      if (epoch === this.epoch) this.set({ status: err instanceof ApiError && err.kind === 'not_found' ? 'not_found' : 'unavailable' });
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  /** Opens the session, reads its conversation and follows its stream from the last seq. */
  private async open(epoch: number): Promise<void> {
    const opened = await ensureSession(this.slug, this.previewDeskId);
    if (epoch !== this.epoch) return;
    this.set({ session: opened.state });
    let transcript: VisitorTranscript;
    try {
      transcript = await request('visitorSession', { params: { slug: this.slug } });
    } catch (err) {
      if (epoch !== this.epoch || !sessionGone(err)) throw err;
      this.loaded = true;
      this.dispatch({ type: 'ended' });
      this.set({ status: 'ready' });
      return;
    }
    if (epoch !== this.epoch) return;
    this.dispatch({ type: 'history', transcript });
    this.knownN = transcript.items.reduce((max, item) => Math.max(max, item.n), 0);
    this.loaded = true;
    this.set({ status: 'ready' });
    if (this.users > 0) this.startStream();
  }

  private startStream(): void {
    this.stop();
    const epoch = this.epoch;
    const url = apiPath('events', { slug: this.slug }, { after: String(this.snapshot.state.lastSeq) });
    this.stopStream = openStream<SseEvent>(url, EVENT_TYPES, {
      event: (seq, ev) => {
        if (epoch === this.epoch) this.dispatch({ type: 'event', seq, ev });
      },
      state: (state) => {
        if (epoch === this.epoch) this.onStreamState(state, epoch);
      },
    });
  }

  private onStreamState(state: StreamState, epoch: number): void {
    if (state === 'closed') {
      this.stopStream = null;
      void this.afterClose(epoch);
      return;
    }
    if (state === 'open') this.reopens = 0;
    this.dispatch({ type: 'connection', connection: state });
  }

  /**
   * The server closed the stream, which the browser never retries. A 401 for the conversation means
   * the chat ended; otherwise the stream reopens from the last seq, three times, then gives up.
   */
  private async afterClose(epoch: number): Promise<void> {
    this.dispatch({ type: 'connection', connection: 'reconnecting' });
    try {
      await request('visitorSession', { params: { slug: this.slug } });
    } catch (err) {
      if (epoch !== this.epoch) return;
      if (sessionGone(err)) {
        this.dispatch({ type: 'ended' });
        this.dispatch({ type: 'connection', connection: 'closed' });
        return;
      }
    }
    if (epoch !== this.epoch) return;
    const delay = REOPEN_DELAYS_MS[this.reopens];
    if (delay === undefined) {
      this.dispatch({ type: 'connection', connection: 'closed' });
      return;
    }
    this.reopens += 1;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (epoch === this.epoch) this.startStream();
    }, delay);
  }

  readonly retry = (): void => {
    const { status, state } = this.snapshot;
    if (status === 'unavailable') {
      void this.load();
    } else if (state.connection === 'closed' && state.error !== 'session') {
      this.reopens = 0;
      this.startStream();
    }
  };

  readonly newChat = (): void => {
    this.epoch += 1;
    const epoch = this.epoch;
    this.stop();
    this.loaded = false;
    this.reopens = 0;
    this.knownN = 0;
    this.dispatch({ type: 'reset' });
    this.set({ session: null, status: 'loading', cancelling: null, cancelFailed: false });
    this.loading = true;
    this.open(epoch)
      .catch((err: unknown) => {
        if (epoch === this.epoch) this.set({ status: err instanceof ApiError && err.kind === 'not_found' ? 'not_found' : 'unavailable' });
      })
      .finally(() => {
        if (epoch === this.epoch) this.loading = false;
      });
  };

  readonly send = (text: string): void => {
    const { status, state } = this.snapshot;
    if (status !== 'ready' || state.error === 'session' || text.trim() === '') return;
    this.nextId += 1;
    const id = `${LOCAL_ID}${this.nextId}`;
    this.dispatch({ type: 'sent', id, text });
    void this.post(id, text);
  };

  readonly resend = (id: string): void => {
    const row = this.snapshot.state.rows.find((r) => r.item.kind === 'visitor' && r.item.id === id && r.item.status === 'failed');
    if (row?.item.kind !== 'visitor' || this.snapshot.state.error === 'session') return;
    this.dispatch({ type: 'resent', id });
    void this.post(id, row.item.text);
  };

  private async post(id: string, text: string): Promise<void> {
    try {
      await request('sendMessage', { params: { slug: this.slug }, body: { text } });
    } catch (err) {
      if (isUncertain(err)) {
        this.dispatch({ type: 'send_checking', id });
        await this.check(id, text);
      } else {
        this.fail(id, failureOf(err));
      }
    }
  }

  private fail(id: string, failure: SendFailure): void {
    this.dispatch({ type: 'send_failed', id, failure });
    if (failure === 'session') this.dispatch({ type: 'ended' });
  }

  /**
   * A message whose answer was lost may have gone through: it did when the conversation holds it
   * past the last read, more times than the chat's other copies of the same words that did.
   */
  private async check(id: string, text: string): Promise<void> {
    let transcript: VisitorTranscript;
    try {
      transcript = await request('visitorSession', { params: { slug: this.slug } });
    } catch (err) {
      this.fail(id, sessionGone(err) ? 'session' : 'not_sent');
      return;
    }
    const stored = transcript.items.filter((item) => item.kind === 'visitor_text' && item.n > this.knownN && item.text === text).length;
    const others = this.snapshot.state.rows.filter(
      ({ item }) => item.kind === 'visitor' && item.id !== id && item.id.startsWith(LOCAL_ID) && item.text === text && item.status === 'sent',
    ).length;
    if (stored > others) this.dispatch({ type: 'resent', id });
    else this.fail(id, 'not_sent');
  }

  readonly cancel = (decisionId: string): void => {
    if (this.snapshot.cancelling !== null) return;
    this.set({ cancelling: decisionId, cancelFailed: false });
    void this.cancelHold(decisionId);
  };

  private async cancelHold(decisionId: string): Promise<void> {
    try {
      // Accepted: the outcome arrives on the stream, which clears `cancelling`.
      await request('cancelRequest', { params: { slug: this.slug, decision_id: decisionId } });
      if (!this.snapshot.state.openHolds.includes(decisionId)) this.set({ cancelling: null });
    } catch (err) {
      if (sessionGone(err)) {
        this.set({ cancelling: null });
        this.dispatch({ type: 'ended' });
        return;
      }
      // Already resolved (the owner answered first): the stream brings that outcome.
      if (err instanceof ApiError && err.kind === 'conflict') {
        this.set({ cancelling: null });
        return;
      }
      const applied = isUncertain(err) && (await this.wasResolved(decisionId));
      this.set({ cancelling: null, cancelFailed: !applied });
    }
  }

  /** Whether the conversation holds an outcome for `decisionId`: a lost cancel that went through. */
  private async wasResolved(decisionId: string): Promise<boolean> {
    try {
      const transcript = await request('visitorSession', { params: { slug: this.slug } });
      return transcript.items.some((item) => item.event?.type === 'resolved' && item.event.decision_id === decisionId);
    } catch {
      return false;
    }
  }
}

/** Every chat this app has opened, by slug. */
class PublicChats {
  private readonly chats = new Map<string, VisitorChat>();

  chat(slug: string, previewDeskId: string | undefined): VisitorChat {
    let chat = this.chats.get(slug);
    if (chat === undefined) {
      chat = new VisitorChat(slug, previewDeskId, browserLanguage());
      this.chats.set(slug, chat);
    }
    return chat;
  }
}

const PublicChatsContext = createContext<PublicChats | null>(null);

export function PublicChatProvider({ children }: { children: ReactNode }) {
  const [chats] = useState(() => new PublicChats());
  return <PublicChatsContext.Provider value={chats}>{children}</PublicChatsContext.Provider>;
}

/**
 * The visitor's chat with `slug`'s Desk, kept per slug in `PublicChatProvider`. Its stream is open
 * while a page shows it.
 */
export function useVisitorChat(slug: string, previewDeskId?: string): VisitorChatView {
  const chats = useContext(PublicChatsContext);
  if (chats === null) throw new Error('useVisitorChat needs a PublicChatProvider');
  const chat = chats.chat(slug, previewDeskId);
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);

  useEffect(() => {
    chat.attach();
    return () => chat.detach();
  }, [chat]);

  return useMemo(
    () => ({ ...snapshot, send: chat.send, resend: chat.resend, retry: chat.retry, newChat: chat.newChat, cancel: chat.cancel }),
    [snapshot, chat],
  );
}
