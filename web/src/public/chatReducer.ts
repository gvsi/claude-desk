/**
 * The visitor's chat as a pure reducer: the transcript read at load, the events the stream brings
 * and what the composer sends become rows with their receipts, the writing line and the state of
 * the connection. Nothing here writes copy: every line shown is the kernel's or the design system's.
 *
 * Each message and receipt shows once. The stream resumes after `lastSeq`, and a replay of events
 * the chat already holds (a transcript read before their seqs were known) is matched by identity:
 * a message by its `message_id`, a status by its `(decision_id, ledger_seq)`.
 */
import type { EvDemoInbox, EvErrorCode, EvMessage, EvOwnerJoined, EvOwnerLeft, SseEvent, StatusEvent } from '../api/contracts.ts';
import type { StreamState } from '../api/stream.ts';
import type { TranscriptItem, VisitorTranscript } from '../api/views.ts';
import { receiptFromEvent, type ReceiptView } from '../ds/index.ts';
import { addPart, emptyGroups, groupRows, settle, type GroupedRow, type RowGroups, type RowPart } from '../lib/transcript.ts';

/** The visitor's own message: `sent`, being checked after an answer was lost, or `failed`. */
export type VisitorStatus = 'sent' | 'checking' | 'failed';

/** Why a message didn't send: too many too fast, too long, not sent, or the chat ended. */
export type SendFailure = 'rate_limited' | 'too_long' | 'not_sent' | 'session';

export type ChatItem =
  | { kind: 'visitor'; id: string; text: string; status: VisitorStatus; failure?: SendFailure }
  | { kind: 'message'; seq: number | null; ev: EvMessage }
  | { kind: 'system'; seq: number; ev: EvOwnerJoined | EvOwnerLeft };

export type ChatRow = GroupedRow<ChatItem, ReceiptView>;

export interface ChatState extends RowGroups<ChatItem, ReceiptView> {
  writing: boolean;
  /** The highest seq the chat has seen; the stream resumes after it. */
  lastSeq: number;
  connection: StreamState;
  /** Why the last turn ended without a reply, or `session` when the chat ended. */
  error: EvErrorCode | null;
  /** Held requests the visitor can still cancel, oldest first. */
  openHolds: string[];
  /** Demo inbox notices for this chat (no code in them). */
  inbox: EvDemoInbox[];
  /** What the chat already shows: `m:{message_id}` and `s:{decision_id}:{ledger_seq}`. */
  seen: ReadonlySet<string>;
}

export type ChatAction =
  /** The stored conversation, read at load: it replaces whatever the chat held. */
  | { type: 'history'; transcript: VisitorTranscript }
  | { type: 'event'; seq: number; ev: SseEvent }
  /** The visitor sent a message: it shows at once, in its place. */
  | { type: 'sent'; id: string; text: string }
  /** Its answer was lost, so the chat reads the conversation before saying anything. */
  | { type: 'send_checking'; id: string }
  | { type: 'send_failed'; id: string; failure: SendFailure }
  /** Sent again with "Try again", or found in the conversation after a lost answer. */
  | { type: 'resent'; id: string }
  | { type: 'connection'; connection: StreamState }
  /** A visitor route answered 401: the chat's session is gone. */
  | { type: 'ended' }
  /** A new chat starts empty. */
  | { type: 'reset' };

export function initialChatState(): ChatState {
  return {
    ...emptyGroups<ChatItem, ReceiptView>(),
    writing: false,
    lastSeq: 0,
    connection: 'open',
    error: null,
    openHolds: [],
    inbox: [],
    seen: new Set(),
  };
}

const messageKey = (ev: EvMessage) => `m:${ev.message_id}`;
const statusKey = (ev: StatusEvent) => `s:${ev.decision_id}:${ev.ledger_seq}`;

function isStatus(ev: TranscriptItem['event']): ev is StatusEvent {
  return ev !== null && (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved');
}

/** A held request is open until its resolution arrives. */
function withHolds(openHolds: string[], ev: StatusEvent): string[] {
  if (ev.type === 'held') return openHolds.includes(ev.decision_id) ? openHolds : [...openHolds, ev.decision_id];
  if (ev.type === 'resolved') return openHolds.filter((id) => id !== ev.decision_id);
  return openHolds;
}

/** How a stored item joins the visitor's chat: their words, a delivered message, or a status. */
function historyPart(item: TranscriptItem): RowPart<ChatItem, ReceiptView> | null {
  if (item.kind === 'visitor_text') {
    return { kind: 'turn', row: { kind: 'visitor', id: `n${item.n}`, text: item.text ?? '', status: 'sent' } };
  }
  if (item.kind === 'delivered' && item.event?.type === 'message') {
    return { kind: 'reply', row: { kind: 'message', seq: null, ev: item.event }, receipt: receiptFromEvent(item.event) };
  }
  if (item.kind === 'status' && isStatus(item.event)) return { kind: 'receipt', receipt: receiptFromEvent(item.event) };
  // Whispers and agents' text never reach a visitor's transcript; anything else is left out.
  return null;
}

function fromHistory(transcript: VisitorTranscript): ChatState {
  const items = [...transcript.items].sort((a, b) => a.n - b.n);
  const seen = new Set<string>();
  let openHolds: string[] = [];
  for (const { event } of items) {
    if (event?.type === 'message') seen.add(messageKey(event));
    else if (isStatus(event)) {
      seen.add(statusKey(event));
      openHolds = withHolds(openHolds, event);
    }
  }
  return {
    ...initialChatState(),
    ...groupRows(items, historyPart),
    lastSeq: transcript.last_seq,
    openHolds,
    seen,
  };
}

function onEvent(state: ChatState, seq: number, ev: SseEvent): ChatState {
  switch (ev.type) {
    case 'writing':
      return { ...state, writing: true, error: null };
    case 'turn_end':
      return { ...state, ...settle(state), writing: false };
    case 'message': {
      const key = messageKey(ev);
      if (state.seen.has(key)) return state;
      return {
        ...state,
        ...addPart(state, { kind: 'reply', row: { kind: 'message', seq, ev }, receipt: receiptFromEvent(ev) }),
        writing: false,
        seen: new Set(state.seen).add(key),
      };
    }
    case 'receipt':
    case 'held':
    case 'resolved': {
      const key = statusKey(ev);
      if (state.seen.has(key)) return state;
      return {
        ...state,
        ...addPart(state, { kind: 'receipt', receipt: receiptFromEvent(ev) }),
        openHolds: withHolds(state.openHolds, ev),
        seen: new Set(state.seen).add(key),
      };
    }
    case 'owner_joined':
    case 'owner_left':
      return { ...state, ...addPart(state, { kind: 'line', row: { kind: 'system', seq, ev } }), writing: false };
    case 'demo_inbox':
      return { ...state, inbox: [...state.inbox, ev] };
    case 'error':
      return { ...state, ...settle(state), writing: false, error: ev.code };
  }
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
      return { ...fromHistory(action.transcript), connection: state.connection };
    case 'event':
      // Seen already: the stream resumed from an earlier seq.
      if (action.seq <= state.lastSeq) return state;
      return onEvent({ ...state, lastSeq: action.seq }, action.seq, action.ev);
    case 'sent': {
      const row: ChatItem = { kind: 'visitor', id: action.id, text: action.text, status: 'sent' };
      // A chat that ended stays ended; any other error was the last turn's.
      return { ...state, ...addPart(state, { kind: 'turn', row }), error: state.error === 'session' ? 'session' : null };
    }
    case 'send_checking':
      return withVisitor(state, action.id, (item) => ({ ...item, status: 'checking' }));
    case 'send_failed':
      return withVisitor(state, action.id, (item) => ({ ...item, status: 'failed', failure: action.failure }));
    case 'resent':
      return withVisitor(state, action.id, ({ failure: _failure, ...item }) => ({ ...item, status: 'sent' }));
    case 'connection':
      return { ...state, connection: action.connection };
    case 'ended':
      return { ...state, ...settle(state), writing: false, error: 'session' };
    case 'reset':
      return initialChatState();
  }
}
