/**
 * The visitor's chat as a pure reducer: the transcript read at load, the events the stream brings
 * and what the composer sends become rows with their receipts, the writing line and the state of
 * the connection. Nothing here writes copy: every line shown is the kernel's or the design system's.
 *
 * Each message and receipt shows once. The stream resumes after `lastSeq`, and a replay of events
 * the chat already holds (a transcript read before their seqs were known) is matched by identity:
 * a message by its `message_id`, a status by its `(decision_id, ledger_seq)`.
 *
 * Where the owner joined and left shows the same whether the page was open or loaded later: the
 * stored conversation keeps each join and leave, and each becomes the line the stream's event for it
 * does, two joins in a row included (a hand-back whose leave was never kept). Those events carry no
 * identity, so only the cursor keeps one from showing twice: the API reads `last_seq` in the same
 * snapshot as the items, so the stream resumes after the last join or leave the transcript holds.
 *
 * A decision's later status replaces its previous receipt under the same message, however far
 * the chat has gone on, except that an approved receipt stays and its outcome joins below it.
 * Every line remains the event's own visitor_plain.
 * Once Claude is writing, the receipts that follow wait for its reply, so a turn the API starts on
 * its own (after the visitor confirmed it's them) explains its reply too.
 *
 * A row the stream appends (a reply, the owner's words, a line about the chat) arrives `live`, so
 * it lands once with its receipts one by one; the page says `shown` once it has drawn it, and it is
 * live no more. Only what arrives while the chat is following the stream lands. The stored
 * conversation, read at load or after a reload, is never live, and nothing the stream replays adds
 * a row. After the stream drops or the page comes back, the chat is `catchingUp`: what the stream
 * sends then happened while it wasn't following, so it draws still, until the provider says the
 * stream has `caught_up`.
 */
import type {
  EvDemoInbox,
  EvErrorCode,
  EvMessage,
  EvOwnerJoined,
  EvOwnerLeft,
  EvOwnerTyping,
  SessionMode,
  SessionState,
  SseEvent,
  StatusEvent,
} from '../api/contracts.ts';
import type { StreamState } from '../api/stream.ts';
import type { TranscriptItem, VisitorTranscript } from '../api/views.ts';
import { receiptFromEvent, type ReceiptView } from '../ds/index.ts';
import { addPart, emptyGroups, groupRows, opensAReply, settle, type GroupedRow, type RowGroups, type RowPart } from '../lib/transcript.ts';

/** The visitor's own message: `sent`, being checked after an answer was lost, or `failed`. */
export type VisitorStatus = 'sent' | 'checking' | 'failed';

/** Why a message didn't send: too many too fast, too long, not sent, or the chat ended. */
export type SendFailure = 'rate_limited' | 'too_long' | 'not_sent' | 'session';

export type ChatItem =
  | { kind: 'visitor'; id: string; text: string; status: VisitorStatus; failure?: SendFailure }
  | { kind: 'message'; seq: number | null; ev: EvMessage }
  /** The owner joined or left: `id` is `n{n}` for a line read from the stored conversation, `s{seq}` for one the stream brought. */
  | { kind: 'system'; id: string; ev: EvOwnerJoined | EvOwnerLeft };

export type ChatRow = GroupedRow<ChatItem, ReceiptView>;

/** The owner typing after a take-over: the owner's name, and the time the API said the dots last until. */
export type OwnerTyping = Omit<EvOwnerTyping, 'type'>;

export interface ChatState extends RowGroups<ChatItem, ReceiptView> {
  writing: boolean;
  /**
   * The owner typing after a take-over, from the owner's latest `owner_typing`, or null: her name
   * and until when, never her words. The public page shows it as WritingIndicator's person form.
   * The owner's own message (even one the chat already shows), `owner_left`, the turn's end, an
   * error or the chat ending (`ended`) clears it, and the owner's next typing event replaces it. Its `until` is kept as the API
   * sent it, never compared with a clock here: the provider reads it once with
   * `ownerTypingDelayMs`, so a stale event shows nothing (`stale`) and the dots go when that time
   * runs out (`owner_typing_over`).
   */
  ownerTyping: OwnerTyping | null;
  /** The highest seq the chat has seen; the stream resumes after it. */
  lastSeq: number;
  /**
   * The stream is sending what the chat missed (after it dropped, or the page came back), so the
   * rows it appends draw still. A read of the stored conversation, or `caught_up`, ends it.
   */
  catchingUp: boolean;
  connection: StreamState;
  /** Why the last turn ended without a reply, or `session` when the chat ended. */
  error: EvErrorCode | null;
  /** Held requests the visitor can still cancel, oldest first. */
  openHolds: string[];
  /**
   * How many times the stream has said what came of a turn: Claude started writing, a reply came,
   * the turn ended, it failed, the owner joined or left, the chat ended, or the stored conversation
   * was read. A receipt or a held request's outcome doesn't count. The page holds Send from the
   * visitor's message until this moves.
   */
  turnMarks: number;
  /** Each decision's latest receipt, used to replace it or attach an outcome below its approval. */
  latest: ReadonlyMap<string, ReceiptView>;
  /** Demo inbox notices for this chat (no code in them). */
  inbox: EvDemoInbox[];
  /** What the chat already shows: `m:{message_id}` and `s:{decision_id}:{ledger_seq}`. */
  seen: ReadonlySet<string>;
}

export type ChatAction =
  /** The stored conversation, read at load: it replaces whatever the chat held. */
  | { type: 'history'; transcript: VisitorTranscript }
  | { type: 'event'; seq: number; ev: SseEvent }
  /** An event too old to show (an owner typing whose time has passed): the stream goes on after it. */
  | { type: 'stale'; seq: number }
  /** The owner's typing ran out of time. */
  | { type: 'owner_typing_over' }
  /** The visitor sent a message: it shows at once, in its place. */
  | { type: 'sent'; id: string; text: string }
  /** The page has drawn the rows that arrived live: they are live no more. */
  | { type: 'shown' }
  /** The page came back to the chat: the stream it resumes sends what happened meanwhile first. */
  | { type: 'catching_up' }
  /** The stream has sent what the chat missed: what it sends now arrives live. */
  | { type: 'caught_up' }
  /** Its answer was lost, so the chat reads the conversation before saying anything. */
  | { type: 'send_checking'; id: string }
  | { type: 'send_failed'; id: string; failure: SendFailure }
  /** Sent again with "Try again", or found in the conversation after a lost answer. */
  | { type: 'resent'; id: string }
  /** The stream's state. When it drops (`reconnecting`, `closed`), the chat is catching up. */
  | { type: 'connection'; connection: StreamState }
  /** A visitor route answered 401: the chat's session is gone. */
  | { type: 'ended' }
  /** A new chat starts empty. */
  | { type: 'reset' };

export function initialChatState(): ChatState {
  return {
    ...emptyGroups<ChatItem, ReceiptView>(),
    writing: false,
    ownerTyping: null,
    lastSeq: 0,
    catchingUp: false,
    connection: 'open',
    error: null,
    openHolds: [],
    turnMarks: 0,
    latest: new Map(),
    inbox: [],
    seen: new Set(),
  };
}

/** The API shows the owner typing for 5 s after each ping: the dots never stay longer. */
const OWNER_TYPING_MAX_MS = 5_000;

/**
 * How long the owner's typing shows, from `nowMs` (the browser's `Date.now()`): until the event's
 * `until`, never longer than the API's 5 s, so a clock that runs behind can't keep the dots up.
 * At 0 the event is stale and shows nothing, as is one whose time can't be read.
 */
export function ownerTypingDelayMs(ev: EvOwnerTyping, nowMs: number): number {
  const left = Date.parse(ev.until) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.min(left, OWNER_TYPING_MAX_MS);
}

/** What the visitor chat knows when it says whether the owner is in the chat. */
export interface OwnerInChatFacts {
  /** The session as the chat holds it: its mode is the kernel's, as `PublicChatProvider` keeps it. */
  session: SessionState | null;
  state: ChatState;
  /** The chat has loaded (its status is `ready`). */
  ready: boolean;
  /**
   * The chat knows the session's mode now: the read it opened with, and since it last lost track of
   * the stream (a drop, the page going away), an `owner_joined` or a read of the session.
   */
  modeKnown: boolean;
}

/**
 * Whether the page says the owner is in the chat (PublicShell's `ownerInChat`, which changes the AI
 * disclosure's line). Its one source is the kernel's session mode, `session.mode === 'owner'`, which
 * only the chat's opening read and the stream's `owner_joined` can set (`PublicChatProvider`). The
 * chat's lines never turn it on. Everything else only turns it off: no session or any other mode, a
 * chat not loaded, a mode not confirmed since the chat lost track of the stream, an error (the chat
 * ending included), and a stream that is down or catching up on what it missed.
 */
export function ownerInChatNow({ session, state, ready, modeKnown }: OwnerInChatFacts): boolean {
  return session?.mode === 'owner' && modeKnown && ready && state.error === null && state.connection === 'open' && !state.catchingUp;
}

/**
 * The mode an answer after the chat has loaded may give the session: what it `said`, but never the
 * owner's unless the chat already has it, since the answer may have been taken before a hand-back the
 * stream has shown since. `said` is null for a read older than the stream's latest change of mode,
 * which says nothing of it. Only the opening read and `owner_joined` put the chat in her hands.
 */
export function lowerOnly(current: SessionMode | null, said: SessionMode | null): SessionMode {
  return said === null || said === 'owner' ? (current ?? 'ai') : said;
}

const messageKey = (ev: EvMessage) => `m:${ev.message_id}`;
const statusKey = (ev: StatusEvent) => `s:${ev.decision_id}:${ev.ledger_seq}`;

function isStatus(ev: TranscriptItem['event']): ev is StatusEvent {
  return ev !== null && (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved');
}

function isPresence(ev: TranscriptItem['event']): ev is EvOwnerJoined | EvOwnerLeft {
  return ev !== null && (ev.type === 'owner_joined' || ev.type === 'owner_left');
}

/** The line for the owner joining or leaving, `id` as `ChatItem` names it. */
function presenceLine(id: string, ev: EvOwnerJoined | EvOwnerLeft): RowPart<ChatItem, ReceiptView> {
  return { kind: 'line', row: { kind: 'system', id, ev } };
}

/** Approval or a resolved outcome ends the visitor's chance to cancel a held request. */
export function closesHold(ev: SseEvent | null | undefined): ev is StatusEvent {
  return ev?.type === 'resolved' || (ev?.type === 'receipt' && ev.state === 'approved');
}

/** A held request can be cancelled until approval or its resolution arrives. */
function withHolds(openHolds: string[], ev: StatusEvent): string[] {
  if (ev.type === 'held') return openHolds.includes(ev.decision_id) ? openHolds : [...openHolds, ev.decision_id];
  if (closesHold(ev)) {
    return openHolds.filter((id) => id !== ev.decision_id);
  }
  return openHolds;
}

/**
 * A status replaces the decision's previous receipt, except that an approved receipt stays and
 * its outcome attaches below it in the same place. Keep the latest reference so further outcomes
 * replace that outcome (including unknown → final), leaving the approval above it.
 */
function statusPart(
  latest: ReadonlyMap<string, ReceiptView>,
  ev: StatusEvent,
): { part: RowPart<ChatItem, ReceiptView>; latest: ReadonlyMap<string, ReceiptView> } {
  const receipt = receiptFromEvent(ev);
  const previous = latest.get(ev.decision_id);
  const approved = previous?.source.kind === 'decision' && previous.source.state === 'approved';
  return {
    part: { kind: 'receipt', receipt, ...(approved ? { after: previous } : { replaces: previous }) },
    latest: new Map(latest).set(ev.decision_id, receipt),
  };
}

function fromHistory(transcript: VisitorTranscript): ChatState {
  const items = [...transcript.items].sort((a, b) => a.n - b.n);
  const seen = new Set<string>();
  let openHolds: string[] = [];
  let latest: ReadonlyMap<string, ReceiptView> = new Map();
  // How a stored item joins the chat: the visitor's words, a delivered message, a status, or where
  // the owner joined or left, as the stream's events for them do.
  const partOf = (item: TranscriptItem): RowPart<ChatItem, ReceiptView> | null => {
    const { event } = item;
    if (item.kind === 'visitor_text') {
      return { kind: 'turn', row: { kind: 'visitor', id: `n${item.n}`, text: item.text ?? '', status: 'sent' } };
    }
    if (item.kind === 'delivered' && event?.type === 'message') {
      seen.add(messageKey(event));
      return { kind: 'reply', row: { kind: 'message', seq: null, ev: event }, receipt: receiptFromEvent(event) };
    }
    if (item.kind === 'status' && isStatus(event)) {
      seen.add(statusKey(event));
      openHolds = withHolds(openHolds, event);
      const status = statusPart(latest, event);
      latest = status.latest;
      return status.part;
    }
    // Each join and leave kept is a line of its own.
    if (isPresence(event) && event.type === item.kind) return presenceLine(`n${item.n}`, event);
    // Whispers and agents' text never reach a visitor's transcript; anything else is left out.
    return null;
  };
  // A stored conversation has no writing events: a turn Claude started on its own is found by what
  // follows a decision's status, as the owner's view finds it.
  const groups = groupRows(items, partOf, { writingBefore: opensAReply });
  return { ...initialChatState(), ...groups, lastSeq: transcript.last_seq, openHolds, latest, seen };
}

function onEvent(state: ChatState, seq: number, ev: SseEvent): ChatState {
  switch (ev.type) {
    case 'writing':
      // Claude has started a turn: what it does now explains the reply it is writing, so the turn's
      // receipts wait for that reply, even in a turn the API started with no visitor message.
      return { ...state, ...addPart(state, { kind: 'writing' }), writing: true, error: null, turnMarks: state.turnMarks + 1 };
    case 'turn_end':
      return { ...state, ...settle(state), writing: false, ownerTyping: null, turnMarks: state.turnMarks + 1 };
    case 'message': {
      const key = messageKey(ev);
      // The owner's own words replace the owner's typing dots, even when the chat already shows them.
      const ownerTyping = ev.author === 'owner' ? null : state.ownerTyping;
      if (state.seen.has(key)) return { ...state, ownerTyping };
      return {
        ...state,
        ...arrived(state, addPart(state, { kind: 'reply', row: { kind: 'message', seq, ev }, receipt: receiptFromEvent(ev) })),
        writing: false,
        ownerTyping,
        seen: new Set(state.seen).add(key),
        turnMarks: state.turnMarks + 1,
      };
    }
    case 'receipt':
    case 'held':
    case 'resolved': {
      const key = statusKey(ev);
      if (state.seen.has(key)) return state;
      const { part, latest } = statusPart(state.latest, ev);
      return {
        ...state,
        ...addPart(state, part),
        openHolds: withHolds(state.openHolds, ev),
        latest,
        seen: new Set(state.seen).add(key),
      };
    }
    case 'owner_joined':
      return { ...state, ...arrived(state, addPart(state, presenceLine(`s${seq}`, ev))), writing: false, turnMarks: state.turnMarks + 1 };
    case 'owner_left':
      return { ...state, ...arrived(state, addPart(state, presenceLine(`s${seq}`, ev))), writing: false, ownerTyping: null, turnMarks: state.turnMarks + 1 };
    case 'owner_typing': {
      // Kept whole, without its type: a later typing event replaces it.
      const { type: _type, ...ownerTyping } = ev;
      return { ...state, ownerTyping };
    }
    case 'demo_inbox':
      return { ...state, inbox: [...state.inbox, ev] };
    case 'error':
      return { ...state, ...settle(state), writing: false, ownerTyping: null, error: ev.code, turnMarks: state.turnMarks + 1 };
  }
}

/**
 * `groups` with its last row, the one the stream just appended, arriving live, unless the chat is
 * catching up on what it missed.
 */
function arrived<G extends RowGroups<ChatItem, ReceiptView>>(state: ChatState, groups: G): G {
  const last = groups.rows.at(-1);
  if (last === undefined || state.catchingUp) return groups;
  return { ...groups, rows: [...groups.rows.slice(0, -1), { ...last, live: true }] };
}

/** The chat with no row live, the same state when none was. */
function shown(state: ChatState): ChatState {
  if (!state.rows.some((row) => row.live === true)) return state;
  return { ...state, rows: state.rows.map(({ live: _live, ...row }) => row) };
}

/** The chat with the visitor's message `id` changed by `change`. */
function withVisitor(state: ChatState, id: string, change: (item: ChatItem & { kind: 'visitor' }) => ChatItem): ChatState {
  return {
    ...state,
    rows: state.rows.map((row) => (row.item.kind === 'visitor' && row.item.id === id ? { ...row, item: change(row.item) } : row)),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history':
      return { ...fromHistory(action.transcript), connection: state.connection, turnMarks: state.turnMarks + 1 };
    case 'event':
      // Seen already: the stream resumed from an earlier seq.
      if (action.seq <= state.lastSeq) return state;
      return onEvent({ ...state, lastSeq: action.seq }, action.seq, action.ev);
    case 'stale':
      return action.seq <= state.lastSeq ? state : { ...state, lastSeq: action.seq };
    case 'owner_typing_over':
      return state.ownerTyping === null ? state : { ...state, ownerTyping: null };
    case 'sent': {
      const row: ChatItem = { kind: 'visitor', id: action.id, text: action.text, status: 'sent' };
      // A chat that ended stays ended; any other error was the last turn's.
      return { ...state, ...addPart(state, { kind: 'turn', row }), error: state.error === 'session' ? 'session' : null };
    }
    case 'shown':
      return shown(state);
    case 'catching_up':
      return state.catchingUp ? state : { ...state, catchingUp: true };
    case 'caught_up':
      return state.catchingUp ? { ...state, catchingUp: false } : state;
    case 'send_checking':
      return withVisitor(state, action.id, (item) => ({ ...item, status: 'checking' }));
    case 'send_failed':
      return withVisitor(state, action.id, (item) => ({ ...item, status: 'failed', failure: action.failure }));
    case 'resent':
      return withVisitor(state, action.id, ({ failure: _failure, ...item }) => ({ ...item, status: 'sent' }));
    case 'connection':
      // The stream resumes after the last seq the chat holds, and sends what it missed first.
      return { ...state, connection: action.connection, catchingUp: state.catchingUp || action.connection !== 'open' };
    case 'ended':
      return { ...state, ...settle(state), writing: false, ownerTyping: null, error: 'session', turnMarks: state.turnMarks + 1 };
    case 'reset':
      return initialChatState();
  }
}
