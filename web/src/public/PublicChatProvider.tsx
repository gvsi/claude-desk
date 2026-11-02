/**
 * The visitor's chats, one per Desk slug, kept for as long as the app runs, so a chat survives its
 * page being unmounted and mounted again. Each chat loads in order (the public Desk, the session,
 * the stored conversation, then the event stream from the last seq it holds), sends what the
 * visitor writes and cancels held requests. A stream that picks up after a gap (the page coming
 * back, a drop) sends what the chat missed first, which draws still: the chat has caught up once
 * the stream has been quiet for `CAUGHT_UP_AFTER_MS`.
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

import type { PublicDesk, SessionMode, SessionState, SseEvent } from '../api/contracts.ts';
import { ApiError, isUncertain, request } from '../api/http.ts';
import { apiPath } from '../api/routes.ts';
import { openStream, type StreamState } from '../api/stream.ts';
import type { VisitorSession, VisitorTranscript } from '../api/views.ts';
import { browserLanguage, type BrowserLanguage } from '../lib/language.ts';
import { paymentLinkMemory, type PaymentLinkMemory } from './paymentLinks.ts';
import {
  chatReducer,
  closesHold,
  initialChatState,
  lowerOnly,
  ownerInChatNow,
  ownerTypingDelayMs,
  type ChatAction,
  type ChatState,
  type SendFailure,
} from './chatReducer.ts';

export type ChatStatus = 'loading' | 'ready' | 'not_found' | 'unavailable';

/**
 * Where the visitor's demo code stands: `checking` while the verify route has it, `failed` when it
 * didn't work (one state for a wrong, expired or used-up code, or any refusal but a 401), and
 * `unreachable` when no answer came and the session isn't verified.
 */
export type VerifyStatus = 'idle' | 'checking' | 'failed' | 'unreachable';

/** How long the chat waits before each reopen of a stream the server closed; after the last, it gives up. */
export const REOPEN_DELAYS_MS = [2_000, 5_000, 10_000] as const;

/**
 * How long a stream that opened after a gap (the page coming back, a drop) stays quiet before the
 * chat has caught up. On opening, the server first sends everything after the chat's last seq, all
 * at once; what it sends after this long with nothing new arrives live.
 */
export const CAUGHT_UP_AFTER_MS = 500;

/**
 * Every event a visitor's stream carries. The stream drops a type it isn't given, so the list is
 * keyed by the contract's types and the compiler names any it leaves out.
 */
const EVENT_TYPES = Object.keys({
  writing: true,
  message: true,
  turn_end: true,
  receipt: true,
  held: true,
  resolved: true,
  owner_joined: true,
  owner_typing: true,
  owner_left: true,
  demo_inbox: true,
  error: true,
} satisfies Record<SseEvent['type'], true>) as SseEvent['type'][];

export interface VisitorChatSnapshot {
  paymentLinks: PaymentLinkMemory;
  /** The public Desk the chat loaded, or null until it has. */
  desk: PublicDesk | null;
  state: ChatState;
  session: SessionState | null;
  status: ChatStatus;
  /** The held request being cancelled, until its outcome arrives. */
  cancelling: string | null;
  /** The held request whose last cancel failed and wasn't applied, or null. */
  cancelFailed: string | null;
  /** Where the last demo code the visitor sent stands. */
  verifyStatus: VerifyStatus;
  /**
   * The owner is in the chat (a take-over), which the chat's head says in the AI disclosure's place:
   * only from the kernel's session mode (`session.mode === 'owner'`, `ownerInChatNow`). Only the
   * opening read, the stream's `owner_joined` and guarded confirming reads put the chat in her hands;
   * her leave, Claude writing and other later answers can only take it out of them. It shows only
   * while the chat is ready, follows the stream, and knows the mode since it last lost track of it.
   * The page passes it to PublicShell as it is.
   */
  ownerInChat: boolean;
}

export interface VisitorChatActions {
  send: (text: string) => void;
  /** Sends a failed message again ("Try again"). */
  resend: (id: string) => Promise<void>;
  /** Loads the Desk again, or reopens a stream the chat gave up on. */
  retry: () => void;
  /** Starts a new chat after this one ended. */
  newChat: () => void;
  cancel: (decisionId: string) => void;
  /** Sends a demo code to the verify route: the kernel checks it, and Claude never sees it. */
  verify: (code: string) => void;
  /** The page has drawn the rows that arrived live: they are live no more, so a remount draws them still. */
  shown: () => void;
}

export type VisitorChatView = VisitorChatSnapshot & VisitorChatActions;

/**
 * Opens a session with `slug`'s Desk. Without `previewDeskId`, the API resumes the chat the browser's
 * visitor cookie names, or opens a new one when there is none. With `previewDeskId`, it always opens a
 * new owner's preview of that Desk (`openPreview` never resumes one), which the API grants only to
 * the owner of its copy; for anyone else it fails, and a plain chat opens instead. So a caller with a
 * preview reads `visitorSession` first and comes here only when the browser has no chat yet, as
 * `openChat` does; otherwise each load would start another preview.
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

/**
 * A chat as it opened: its session, as the read of its stored conversation answered it when there was
 * one (the latest the kernel said, its mode included), and that conversation, or null when the
 * session was gone before it could be read.
 */
export interface OpenedChat {
  session: SessionState;
  transcript: VisitorTranscript | null;
}

/**
 * Opens the chat with `slug`'s Desk (`ensureSession`) and reads its stored conversation. The
 * owner's preview reads first: `openPreview` mints a new preview session every time, and it can't
 * see the chat this browser already has, since the visitor cookie is scoped to the Desk's public
 * path. So a reload, or a second tab from "Chat as a customer", resumes the chat the cookie names,
 * and only a 401 (no chat yet) asks for a preview.
 */
export async function openChat(slug: string, previewDeskId?: string): Promise<OpenedChat> {
  if (previewDeskId !== undefined && previewDeskId !== '') {
    try {
      const transcript = await request('visitorSession', { params: { slug } });
      return { session: transcript.state, transcript };
    } catch (err) {
      if (!sessionGone(err)) throw err;
    }
  }
  const opened = await ensureSession(slug, previewDeskId);
  try {
    const transcript = await request('visitorSession', { params: { slug } });
    return { session: transcript.state, transcript };
  } catch (err) {
    if (!sessionGone(err)) throw err;
    return { session: opened.state, transcript: null };
  }
}

/** Why a send was refused. Only a 422 is the length (Plan 02's limit); any other refusal didn't send. */
function failureOf(err: unknown): SendFailure {
  if (!(err instanceof ApiError)) return 'not_sent';
  if (err.kind === 'unauthorized') return 'session';
  if (err.kind === 'rate_limited') return 'rate_limited';
  if (err.status === 422) return 'too_long';
  return 'not_sent';
}

const LOCAL_ID = 'local-';

class VisitorChat {
  private snapshot: VisitorChatSnapshot = {
    paymentLinks: paymentLinkMemory(),
    desk: null,
    state: initialChatState(),
    session: null,
    status: 'loading',
    cancelling: null,
    cancelFailed: null,
    verifyStatus: 'idle',
    ownerInChat: false,
  };
  private readonly listeners = new Set<() => void>();
  /** Pages showing this chat; the stream is open only while there is one. */
  private users = 0;
  /** Bumped when in-flight loading and streaming must stop applying: a new chat, or nobody watching. */
  private epoch = 0;
  /**
   * Bumped by a new chat only, so that what the chat that ended still has in flight (a send, the
   * read after a lost one, a cancel) never changes the new one. A page going away doesn't bump it:
   * those still belong to this chat, which shows them when a page comes back.
   */
  private generation = 0;
  /** Greatest kernel session generation seen, independent of the event cursor and this chat's lifecycle. */
  private sessionGeneration = -1;
  /** Messages whose answer was lost, by id, until a read of the conversation shows whether they went through. */
  private readonly lost = new Map<string, string>();
  /** A read for the lost messages is out. */
  private checking = false;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private checkRetries = 0;
  private loading = false;
  /** The session and its stored conversation are in. */
  private loaded = false;
  private stopStream: (() => void) | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopens = 0;
  /** The highest `n` in the conversation as last read: a lost message is looked for after it. */
  private knownN = 0;
  private nextId = 0;
  /** Ends the owner's typing when its time runs out. */
  private ownerTypingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Says the chat has caught up once the stream it is catching up on has been quiet long enough. */
  private caughtUpTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The seq as of which the chat knows the session's mode: the cursor (`last_seq`) of the latest read
   * it took the mode from, or the seq of the latest stream event that changed it (a join, a leave,
   * Claude writing or a message not hers), whichever is later. A mode event at or before it is older
   * than what the chat knows, and changes nothing; a read older than it says nothing of the mode.
   */
  private modeAt = 0;
  /**
   * The chat knows the session's mode now: from the read it opened with, and since it last lost
   * track of the stream, from a join it follows live or a read of the session sent after the stream
   * reopened. A join it replays while catching up doesn't count: a hand-back may still be on its way.
   */
  private modeKnown = false;
  /** A cursorless verify answer lowered owner mode; confirm it once the stream can be followed. */
  private verifyModeUnconfirmed = false;
  /** Bumped on a stream gap or a cursorless mode downgrade, so a read sent before then confirms nothing. */
  private tracked = 0;
  /** The stream is open again since the chat last lost track of it: a read sent now can confirm the mode. */
  private following = false;
  /** The in-flight read's tracking count and mode cursor; a later replayed join needs another read. */
  private confirming: { since: number; at: number } | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmRetries = 0;

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

  /** Applies `patch`, and with it whether the owner is in the chat, which only `ownerInChatNow` says. */
  private set(patch: Partial<Omit<VisitorChatSnapshot, 'ownerInChat'>>): void {
    const next = { ...this.snapshot, ...patch };
    this.snapshot = {
      ...next,
      ownerInChat: ownerInChatNow({ session: next.session, state: next.state, ready: next.status === 'ready', modeKnown: this.modeKnown }),
    };
    if (!this.needsModeConfirmation()) this.clearConfirmRetry();
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * The chat has lost track of the stream (a drop, the page going away): what it holds of the
   * session's mode may be old, so the head shows the AI disclosure until a join or a read since
   * says otherwise. The caller sets the state next, which says so.
   */
  private loseTrack(): void {
    this.clearConfirmRetry();
    this.tracked += 1;
    this.modeKnown = false;
    this.following = false;
  }

  /**
   * The session as the chat opens with it, from the read of its stored conversation: the one read
   * that may put the chat in the owner's hands, and the read that confirms the mode once the stream
   * has reopened. The API reads the session's mode, the conversation and its cursor as one snapshot,
   * so its mode stands as read, as of that cursor.
   */
  private openedSession(transcript: VisitorTranscript): SessionState {
    this.observeSession(transcript.state);
    this.modeKnown = true;
    this.verifyModeUnconfirmed = false;
    this.modeAt = transcript.last_seq;
    return transcript.state;
  }

  /**
   * A session from an answer after the chat has opened (a verify, a read of the session): it may
   * take the chat out of the owner's hands, never put it in them (`lowerOnly`), since the answer may
   * have been taken before a hand-back the stream has shown since. `said` is the mode it says.
   */
  private laterSession(next: SessionState, said: SessionMode | null): SessionState {
    this.observeSession(next);
    return { ...next, mode: lowerOnly(this.snapshot.session?.mode ?? null, said) };
  }

  private observeSession(session: SessionState): void {
    this.sessionGeneration = Math.max(this.sessionGeneration, session.generation);
  }

  /**
   * A session from a later read of the stored conversation, sent when the chat had last lost track
   * `since`, and while it was `following` the reopened stream or not. Older than what the chat knows
   * of the mode (`modeAt`), it says nothing of it. Otherwise it says the mode as of its `last_seq`,
   * which may only lower it. Only an applied mode moves the cursor: a refused owner's mode must
   * leave its join available to the stream. It confirms the mode if it was sent after the stream
   * reopened, with nothing lost since.
   */
  private laterRead(transcript: VisitorTranscript, since: number, following: boolean): SessionState {
    const read = transcript.state;
    if (transcript.last_seq < this.modeAt) return this.laterSession(read, null);
    const session = this.laterSession(read, read.mode);
    if (session.mode === read.mode) this.modeAt = transcript.last_seq;
    if (following && since === this.tracked) this.modeKnown = true;
    return session;
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
    if (!this.loaded) {
      void this.load();
      return;
    }
    // Back on the page: the stream picks up after the last seq the chat holds, so what came
    // meanwhile arrives first, and draws still.
    this.loseTrack();
    this.dispatch({ type: 'catching_up' });
    this.startStream();
  }

  detach(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    this.epoch += 1;
    this.loading = false;
    this.stop();
    // The chat no longer follows the stream, and says so now, so a page that shows it again (a
    // remount, the preview reopened) draws it catching up from its first render.
    if (this.loaded) {
      this.loseTrack();
      this.dispatch({ type: 'catching_up' });
    }
    // Nobody is watching: the lost messages are read for again when the stream next opens.
    this.clearCheckTimer();
  }

  private stop(): void {
    this.clearConfirmRetry();
    this.stopStream?.();
    this.stopStream = null;
    if (this.reopenTimer !== null) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.clearCaughtUpTimer();
  }

  /**
   * While the chat is catching up on an open stream, it has caught up once the stream has sent
   * nothing new for `CAUGHT_UP_AFTER_MS`: what the server held back comes first, all at once.
   */
  private awaitCaughtUp(): void {
    this.clearCaughtUpTimer();
    if (!this.snapshot.state.catchingUp) return;
    const epoch = this.epoch;
    this.caughtUpTimer = setTimeout(() => {
      this.caughtUpTimer = null;
      if (epoch === this.epoch) this.dispatch({ type: 'caught_up' });
    }, CAUGHT_UP_AFTER_MS);
  }

  private clearCaughtUpTimer(): void {
    if (this.caughtUpTimer !== null) clearTimeout(this.caughtUpTimer);
    this.caughtUpTimer = null;
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
    const { session, transcript } = await openChat(this.slug, this.previewDeskId);
    if (epoch !== this.epoch) return;
    if (transcript === null) this.set({ session: this.laterSession(session, session.mode) });
    else this.set({ session: this.openedSession(transcript) });
    if (transcript === null) {
      this.loaded = true;
      this.end();
      this.set({ status: 'ready' });
      return;
    }
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
        if (epoch === this.epoch) this.onEvent(seq, ev);
      },
      state: (state) => {
        if (epoch === this.epoch) this.onStreamState(state, epoch);
      },
    });
  }

  /**
   * An event from the stream. The owner's typing shows only until its time, read once here with
   * `ownerTypingDelayMs`: a stale one (replayed after a reload or a reconnect included) shows
   * nothing, and a later one restarts the timer.
   */
  private onEvent(seq: number, ev: SseEvent): void {
    // Still catching up: the stream isn't quiet yet.
    if (this.caughtUpTimer !== null) this.awaitCaughtUp();
    if (ev.type !== 'owner_typing') {
      // An event the chat has already seen (a replay from an earlier seq) changes nothing.
      const fresh = seq > this.snapshot.state.lastSeq;
      this.dispatch({ type: 'event', seq, ev });
      if (fresh) this.followMode(seq, ev);
      return;
    }
    if (seq <= this.snapshot.state.lastSeq) return;
    const delay = ownerTypingDelayMs(ev, Date.now());
    if (delay <= 0) {
      this.dispatch({ type: 'stale', seq });
      return;
    }
    this.dispatch({ type: 'event', seq, ev });
    this.clearOwnerTypingTimer();
    this.ownerTypingTimer = setTimeout(() => {
      this.ownerTypingTimer = null;
      this.dispatch({ type: 'owner_typing_over' });
    }, delay);
  }

  /**
   * The session's mode as the stream changes it, at `seq`: the owner's take-over (`owner_joined`) is
   * the one event that puts the chat in her hands, and confirms it after the chat lost track of the
   * stream. Her hand-back (`owner_left`) puts it in Claude's, and so does anything that comes only
   * while the chat is in Claude's hands: Claude starting to write, or a message that isn't hers
   * (past the model's budget, the loop hands off with a message and no writing first). So a
   * hand-back whose leave never came still ends hers.
   */
  private followMode(seq: number, ev: SseEvent): void {
    const notHers = ev.type === 'owner_left' || ev.type === 'writing' || (ev.type === 'message' && ev.author !== 'owner');
    const mode: SessionMode | null = ev.type === 'owner_joined' ? 'owner' : notHers ? 'ai' : null;
    const { session, state } = this.snapshot;
    // Older than a read the chat took the mode from: that read already counts it.
    if (mode === null || session === null || seq <= this.modeAt) return;
    this.modeAt = seq;
    this.verifyModeUnconfirmed = false;
    // A join the chat follows live confirms her. One it replays while catching up may be older than
    // a hand-back still on its way, so only a read of the session sent now can confirm it.
    const confirm = ev.type === 'owner_joined' && state.catchingUp;
    if (confirm) this.modeKnown = false;
    if (ev.type === 'owner_joined' && !state.catchingUp) this.modeKnown = true;
    this.set({ session: { ...session, mode } });
    if (confirm) void this.confirmMode(this.epoch);
  }

  private clearOwnerTypingTimer(): void {
    if (this.ownerTypingTimer !== null) clearTimeout(this.ownerTypingTimer);
    this.ownerTypingTimer = null;
  }

  /** The chat ended (a 401): the owner's typing goes with it, and its timer too. */
  private end(): void {
    this.clearOwnerTypingTimer();
    this.dispatch({ type: 'ended' });
  }

  private onStreamState(state: StreamState, epoch: number): void {
    if (state === 'closed') {
      this.stopStream = null;
      this.clearCaughtUpTimer();
      this.loseTrack();
      void this.afterClose(epoch);
      return;
    }
    if (state !== 'open') this.loseTrack();
    this.dispatch({ type: 'connection', connection: state });
    if (state !== 'open') {
      // Dropped: the browser opens it again from the last seq, and the chat catches up then.
      this.clearCaughtUpTimer();
      return;
    }
    this.following = true;
    this.awaitCaughtUp();
    // Back on the stream with the chat in the owner's hands, as it last knew: the stream's silence
    // doesn't say she is still there, and the stream has no word for "that was everything you
    // missed", so the chat reads the session to confirm it, or to learn she has left.
    if (this.verifyModeUnconfirmed || (!this.modeKnown && this.snapshot.session?.mode === 'owner')) void this.confirmMode(epoch);
    this.reopens = 0;
    // The server answers again: a good moment to settle any message whose answer was lost.
    this.checkRetries = 0;
    void this.checkLost(this.generation);
  }

  /**
   * Reads the session to confirm the owner's mode after a cursorless verify downgrade or a reopened
   * stream, and again if a replayed join advances beyond that read. A failed or stale read retries on
   * the stream's backoff while the owner remains unconfirmed. Until it answers, the head shows the
   * AI disclosure. Sent after the stream reopened, with nothing lost since and no older than what the
   * stream has said of the mode, it is the session as it stands, as the opening read is.
   */
  private async confirmMode(epoch: number): Promise<void> {
    if (!this.following || this.users === 0 || this.snapshot.state.connection !== 'open' || this.snapshot.state.error === 'session') return;
    if (this.confirming?.since === this.tracked && this.confirming.at >= this.modeAt) return;
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    const since = this.tracked;
    const attempt = { since, at: this.modeAt };
    this.confirming = attempt;
    try {
      const transcript = await request('visitorSession', { params: { slug: this.slug } });
      if (epoch !== this.epoch) return;
      this.observeSession(transcript.state);
      if (since === this.tracked && transcript.last_seq >= this.modeAt && transcript.state.generation >= this.sessionGeneration) this.set({ session: this.openedSession(transcript) });
      else this.set({ session: this.laterRead(transcript, since, false) });
    } catch (err) {
      // Unanswered: nothing is confirmed, and the head keeps the AI disclosure.
      if (epoch === this.epoch && sessionGone(err)) this.end();
    } finally {
      // An older read must not release or schedule a retry for the newer one.
      if (this.confirming === attempt) {
        this.confirming = null;
        if (epoch === this.epoch && since === this.tracked && this.needsModeConfirmation()) {
          const delay = REOPEN_DELAYS_MS[Math.min(this.confirmRetries, REOPEN_DELAYS_MS.length - 1)]!;
          this.confirmRetries += 1;
          this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            if (epoch === this.epoch && since === this.tracked && this.needsModeConfirmation()) void this.confirmMode(epoch);
          }, delay);
        }
      }
    }
  }

  private needsModeConfirmation(): boolean {
    return !this.modeKnown && this.snapshot.session?.mode === 'owner' && this.following && this.users > 0
      && this.snapshot.state.connection === 'open' && this.snapshot.state.error !== 'session';
  }

  private clearConfirmRetry(): void {
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.confirmRetries = 0;
  }

  /**
   * The server closed the stream, which the browser never retries. A 401 for the conversation means
   * the chat ended; otherwise the stream reopens from the last seq, three times, then gives up.
   */
  private async afterClose(epoch: number): Promise<void> {
    this.dispatch({ type: 'connection', connection: 'reconnecting' });
    try {
      const transcript = await request('visitorSession', { params: { slug: this.slug } });
      if (epoch === this.epoch) this.observeSession(transcript.state);
    } catch (err) {
      if (epoch !== this.epoch) return;
      if (sessionGone(err)) {
        this.end();
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
    this.generation += 1;
    this.sessionGeneration = -1;
    const epoch = this.epoch;
    this.stop();
    this.loaded = false;
    this.reopens = 0;
    this.knownN = 0;
    this.lost.clear();
    this.checking = false;
    this.clearCheckTimer();
    this.checkRetries = 0;
    this.clearOwnerTypingTimer();
    // The old session goes before the chat empties, so no state holds its mode beside an empty chat.
    this.loseTrack();
    this.modeAt = 0;
    this.verifyModeUnconfirmed = false;
    this.set({ session: null, status: 'loading', cancelling: null, cancelFailed: null, verifyStatus: 'idle', paymentLinks: paymentLinkMemory() });
    this.dispatch({ type: 'reset' });
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

  readonly shown = (): void => {
    if (this.snapshot.state.rows.some((row) => row.live === true)) this.dispatch({ type: 'shown' });
  };

  readonly resend = async (id: string): Promise<void> => {
    const row = this.snapshot.state.rows.find((r) => r.item.kind === 'visitor' && r.item.id === id && r.item.status === 'failed');
    if (row?.item.kind !== 'visitor' || this.snapshot.state.error === 'session') return;
    this.dispatch({ type: 'resent', id });
    await this.post(id, row.item.text);
  };

  private async post(id: string, text: string): Promise<void> {
    const generation = this.generation;
    try {
      await request('sendMessage', { params: { slug: this.slug }, body: { text } });
    } catch (err) {
      if (generation !== this.generation) return;
      if (isUncertain(err)) {
        this.dispatch({ type: 'send_checking', id });
        this.lost.set(id, text);
        await this.checkLost(generation);
      } else {
        this.fail(id, failureOf(err));
      }
    }
  }

  private fail(id: string, failure: SendFailure): void {
    this.dispatch({ type: 'send_failed', id, failure });
    if (failure === 'session') this.end();
  }

  /**
   * A message whose answer was lost may have gone through, so only a read of the conversation
   * settles it: it went through when the conversation holds it past the last read, more times than
   * the chat's other copies of the same words that did, and didn't when it isn't there. A read that
   * fails settles nothing. The messages stay being checked, with no line and no resend, and the read
   * runs again after 2, 5 and 10 s and whenever the stream opens.
   */
  private async checkLost(generation: number): Promise<void> {
    if (this.checking || this.lost.size === 0) return;
    this.checking = true;
    this.clearCheckTimer();
    const lost = [...this.lost];
    let transcript: VisitorTranscript | null = null;
    let gone = false;
    try {
      transcript = await request('visitorSession', { params: { slug: this.slug } });
    } catch (err) {
      gone = sessionGone(err);
    }
    if (generation !== this.generation) return;
    this.checking = false;
    if (gone) {
      // The chat ended. Whether they went through stays unknown, so nothing is said of them.
      this.lost.clear();
      this.end();
      return;
    }
    if (transcript === null) {
      this.checkLater(generation);
      return;
    }
    this.observeSession(transcript.state);
    this.checkRetries = 0;
    for (const [id, text] of lost) {
      this.lost.delete(id);
      const stored = transcript.items.filter((item) => item.kind === 'visitor_text' && item.n > this.knownN && item.text === text).length;
      const others = this.snapshot.state.rows.filter(
        ({ item }) => item.kind === 'visitor' && item.id !== id && item.id.startsWith(LOCAL_ID) && item.text === text && item.status === 'sent',
      ).length;
      if (stored > others) this.dispatch({ type: 'resent', id });
      else this.fail(id, 'not_sent');
    }
    // Lost while that read was out, which may have been too early to hold them.
    if (this.lost.size > 0) await this.checkLost(generation);
  }

  /** The next read for the lost messages, after 2, 5 then 10 s; after that, when the stream opens. */
  private checkLater(generation: number): void {
    const delay = REOPEN_DELAYS_MS[this.checkRetries];
    if (delay === undefined || this.users === 0) return;
    this.checkRetries += 1;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.checkLost(generation);
    }, delay);
  }

  private clearCheckTimer(): void {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  readonly cancel = (decisionId: string): void => {
    if (this.snapshot.cancelling !== null) return;
    this.set({ cancelling: decisionId, cancelFailed: null });
    void this.cancelHold(decisionId);
  };

  private async cancelHold(decisionId: string): Promise<void> {
    const generation = this.generation;
    try {
      // Accepted: the outcome arrives on the stream, which clears `cancelling`.
      await request('cancelRequest', { params: { slug: this.slug, decision_id: decisionId } });
      if (generation !== this.generation) return;
      if (!this.snapshot.state.openHolds.includes(decisionId)) this.set({ cancelling: null });
    } catch (err) {
      if (generation !== this.generation) return;
      if (sessionGone(err)) {
        this.set({ cancelling: null });
        this.end();
        return;
      }
      // Already resolved (the owner answered first): the stream brings that outcome.
      if (err instanceof ApiError && err.kind === 'conflict') {
        this.set({ cancelling: null });
        return;
      }
      const closed = isUncertain(err) && (await this.wasClosed(decisionId));
      if (generation !== this.generation) return;
      this.set({ cancelling: null, cancelFailed: closed ? null : decisionId });
    }
  }

  readonly verify = (code: string): void => {
    const { status, state, verifyStatus } = this.snapshot;
    if (status !== 'ready' || state.error === 'session' || verifyStatus === 'checking') return;
    this.set({ verifyStatus: 'checking' });
    void this.checkCode(code);
  };

  /**
   * The code goes to the verify route and nowhere else. Verified, the chat's session is the one the
   * kernel answered with. Every refusal but a 401 is the same failed code, as the kernel answers a
   * wrong, expired or used-up code alike; a 401 ends the chat. A lost answer may have verified the
   * session, so the chat reads it before saying the code couldn't be checked.
   */
  private async checkCode(code: string): Promise<void> {
    const generation = this.generation;
    try {
      const { state } = await request('verifyCheck', { params: { slug: this.slug }, body: { code } });
      if (generation !== this.generation) return;
      this.observeSession(state);
      // The answer may have been taken before a hand-back the stream has shown since: it may lower the mode only.
      const loweredOwner = state.verified && this.snapshot.session?.mode === 'owner' && state.mode !== 'owner';
      if (loweredOwner) {
        // With no cursor this answer may also predate a join. Invalidate older confirming reads,
        // keep the AI disclosure, and let a fresh read establish which mode the kernel holds now.
        this.tracked += 1;
        this.modeKnown = false;
        this.verifyModeUnconfirmed = true;
        this.clearConfirmRetry();
      }
      this.set(state.verified ? { verifyStatus: 'idle', session: this.laterSession(state, state.mode) } : { verifyStatus: 'failed' });
      if (loweredOwner) void this.confirmMode(this.epoch);
    } catch (err) {
      if (generation !== this.generation) return;
      if (sessionGone(err)) {
        this.set({ verifyStatus: 'idle' });
        this.end();
        return;
      }
      if (err instanceof ApiError && err.status !== null && err.status >= 400 && err.status < 500) {
        this.set({ verifyStatus: 'failed' });
        return;
      }
      const read = isUncertain(err) ? await this.readSession() : null;
      if (generation !== this.generation) return;
      this.set(
        read?.transcript.state.verified ? { verifyStatus: 'idle', session: this.laterRead(read.transcript, read.since, read.following) } : { verifyStatus: 'unreachable' },
      );
    }
  }

  /**
   * The session's stored conversation as the API holds it now, when the chat had last lost track as it
   * was sent, and whether it was following the reopened stream then; or null when it can't be read.
   */
  private async readSession(): Promise<{ transcript: VisitorTranscript; since: number; following: boolean } | null> {
    const { tracked: since, following } = this;
    const generation = this.generation;
    try {
      const transcript = await request('visitorSession', { params: { slug: this.slug } });
      if (generation === this.generation) this.observeSession(transcript.state);
      return { transcript, since, following };
    } catch {
      return null;
    }
  }

  /** Whether approval or an outcome closed this hold before a lost cancel answer was checked. */
  private async wasClosed(decisionId: string): Promise<boolean> {
    const generation = this.generation;
    try {
      const transcript = await request('visitorSession', { params: { slug: this.slug } });
      if (generation === this.generation) this.observeSession(transcript.state);
      return transcript.items.some((item) => closesHold(item.event) && item.event.decision_id === decisionId);
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
    () => ({
      ...snapshot,
      send: chat.send,
      resend: chat.resend,
      retry: chat.retry,
      newChat: chat.newChat,
      cancel: chat.cancel,
      verify: chat.verify,
      shown: chat.shown,
    }),
    [snapshot, chat],
  );
}
