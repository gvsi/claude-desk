/**
 * How a conversation's items become rows with their receipts attached, shared by the visitor's
 * chat and the owner's conversation view. A row is someone's message or a line about the chat; a
 * receipt is a checkpoint result that attaches under a row.
 *
 * A turn starts with someone's own words (a visitor's message, an agent's request, a whisper) and
 * ends with Claude's reply. The receipts of the actions Claude ran in that turn reach the stream
 * before the reply does, and they attach under the reply, after the reply's own check, because the
 * reply is the message they explain. Any receipt after a reply attaches to the last row; one before
 * any row is kept as `leading`. In the visitor's chat, a decision's newer status replaces its older
 * receipt wherever that one is, however far the conversation has gone on, except that an approved
 * receipt stays and its outcome joins below it under the same message. The owner's view keeps
 * all later receipts beside earlier ones.
 *
 * Claude can also start a turn no one's words began (the API wakes it after the visitor confirmed
 * it's them). Live, its `writing` event says so; a stored conversation keeps no writing events, so
 * `opensAReply` finds such a turn by what follows a decision's status, and both the visitor's chat
 * and the owner's conversation view read it the same way.
 */
import type { RenderedBlock } from '../api/contracts.ts';
import type { TranscriptItem } from '../api/views.ts';

export interface GroupedRow<Row, R> {
  item: Row;
  /** The receipts attached under the row, in order. */
  receipts: R[];
  /**
   * The row arrived while the page was open and hasn't been shown yet: it lands once, its receipts
   * one by one (`TranscriptRow`'s `live`). A row read from a stored conversation never has it.
   */
  live?: boolean;
}

export interface RowGroups<Row, R> {
  rows: GroupedRow<Row, R>[];
  /** Receipts that arrived before any row. */
  leading: R[];
  /** Receipts of the turn in progress, waiting for Claude's reply to attach under. */
  pending: R[];
  /** True after someone's own words, until a reply or a line about the chat follows. */
  awaitingReply: boolean;
}

/** How one item joins the conversation. */
export type RowPart<Row, R> =
  /** Someone's own words, which start a turn: the turn's receipts wait for the reply. */
  | { kind: 'turn'; row: Row }
  /** A delivered message: its own check first, then the turn's receipts. */
  | { kind: 'reply'; row: Row; receipt: R | null }
  /** A line about the chat itself (someone joined or left): it ends the turn. */
  | { kind: 'line'; row: Row }
  /**
   * Claude started a turn of its own, which no one's words began (the API woke it, as after the
   * visitor confirmed it's them): the receipts that follow wait for its reply, as a turn's do.
   */
  | { kind: 'writing' }
  /**
   * A checkpoint result. With `beside`, a receipt already in the conversation that this one
   * follows, it attaches in the same place; when that one isn't there, as any other receipt.
   * With `after`, it inserts directly after that receipt, keeping a visitor's outcome just below
   * its approval. With `replaces`, it takes that receipt's place (a newer decision status).
   */
  | { kind: 'receipt'; receipt: R; beside?: R | undefined; after?: R | undefined; replaces?: R | undefined };

export function emptyGroups<Row, R>(): RowGroups<Row, R> {
  return { rows: [], leading: [], pending: [], awaitingReply: false };
}

/** Attaches `receipts` under the last row, or keeps them as `leading` when there is none. */
function attach<Row, R>(groups: RowGroups<Row, R>, receipts: R[]): RowGroups<Row, R> {
  if (receipts.length === 0) return groups;
  const last = groups.rows.at(-1);
  if (last === undefined) return { ...groups, leading: [...groups.leading, ...receipts] };
  return { ...groups, rows: [...groups.rows.slice(0, -1), { ...last, receipts: [...last.receipts, ...receipts] }] };
}

/**
 * Ends the turn in progress without a reply (it ended silently, with an error, or someone joined):
 * its waiting receipts attach under the last row, so none is ever lost.
 */
export function settle<Row, R>(groups: RowGroups<Row, R>): RowGroups<Row, R> {
  if (groups.pending.length === 0 && !groups.awaitingReply) return groups;
  return { ...attach({ ...groups, pending: [] }, groups.pending), awaitingReply: false };
}

/** Adds to the list holding `beside`, directly after it when asked; null when it isn't there. */
function placeBeside<Row, R>(groups: RowGroups<Row, R>, receipt: R, beside: R, directlyAfter = false): RowGroups<Row, R> | null {
  const insert = (receipts: R[]) => {
    const index = directlyAfter ? receipts.indexOf(beside) + 1 : receipts.length;
    return [...receipts.slice(0, index), receipt, ...receipts.slice(index)];
  };
  for (let i = groups.rows.length - 1; i >= 0; i -= 1) {
    const row = groups.rows[i];
    if (row?.receipts.includes(beside)) {
      const rows = [...groups.rows];
      rows[i] = { ...row, receipts: insert(row.receipts) };
      return { ...groups, rows };
    }
  }
  if (groups.pending.includes(beside)) return { ...groups, pending: insert(groups.pending) };
  if (groups.leading.includes(beside)) return { ...groups, leading: insert(groups.leading) };
  return null;
}

/** Replaces a receipt in its existing place, including before its reply has arrived. */
function replaceReceipt<Row, R>(groups: RowGroups<Row, R>, receipt: R, replaces: R): RowGroups<Row, R> | null {
  const replace = (receipts: R[]) => receipts.map((current) => (current === replaces ? receipt : current));
  const index = groups.rows.findIndex((row) => row.receipts.includes(replaces));
  const row = groups.rows[index];
  if (row !== undefined) {
    const rows = [...groups.rows];
    rows[index] = { ...row, receipts: replace(row.receipts) };
    return { ...groups, rows };
  }
  if (groups.pending.includes(replaces)) return { ...groups, pending: replace(groups.pending) };
  if (groups.leading.includes(replaces)) return { ...groups, leading: replace(groups.leading) };
  return null;
}

/** The conversation with one more item. */
export function addPart<Row, R>(groups: RowGroups<Row, R>, part: RowPart<Row, R>): RowGroups<Row, R> {
  switch (part.kind) {
    case 'turn': {
      const settled = settle(groups);
      return { ...settled, rows: [...settled.rows, { item: part.row, receipts: [] }], awaitingReply: true };
    }
    case 'reply': {
      const own = part.receipt === null ? [] : [part.receipt];
      const row = { item: part.row, receipts: [...own, ...groups.pending] };
      return { ...groups, rows: [...groups.rows, row], pending: [], awaitingReply: false };
    }
    case 'line': {
      const settled = settle(groups);
      return { ...settled, rows: [...settled.rows, { item: part.row, receipts: [] }] };
    }
    case 'writing':
      return groups.awaitingReply ? groups : { ...groups, awaitingReply: true };
    case 'receipt': {
      const replaced = part.replaces === undefined ? null : replaceReceipt(groups, part.receipt, part.replaces);
      if (replaced !== null) return replaced;
      const after = part.after === undefined ? null : placeBeside(groups, part.receipt, part.after, true);
      if (after !== null) return after;
      const placed = part.beside === undefined ? null : placeBeside(groups, part.receipt, part.beside);
      if (placed !== null) return placed;
      if (groups.awaitingReply) return { ...groups, pending: [...groups.pending, part.receipt] };
      return attach(groups, [part.receipt]);
    }
  }
}

/**
 * Whether the stored item at `index` is a decide-time receipt or hold, rather than an owner's
 * later approval or a resolved outcome, that comes before Claude's reply with no one's words
 * between them: it belongs to that reply's turn, which Claude may have started on its own.
 * `items` are in their `n` order: the visitor's transcript or the owner's, whose items have kinds of their own.
 */
export function opensAReply(items: readonly (Pick<TranscriptItem, 'event'> & { kind: string })[], index: number): boolean {
  const event = items[index]?.event;
  if (event?.type !== 'receipt' && event?.type !== 'held') return false;
  if (event.type === 'receipt' && event.state === 'approved') return false;
  const next = items.slice(index + 1).find((item) => item.kind !== 'status');
  return next?.kind === 'delivered' && next.event?.type === 'message' && next.event.author !== 'owner';
}

export interface GroupOptions<T> {
  /**
   * Whether Claude started a turn of its own just before `items[index]`, which a stored
   * conversation doesn't record (`opensAReply` for a transcript): that item and the receipts after
   * it wait for Claude's reply, as they do after a `writing` part.
   */
  writingBefore?: (items: readonly T[], index: number) => boolean;
}

/**
 * Rows for a stored conversation, in the items' order. `partOf` reads each item (null skips it).
 * The result is settled: a turn that has no reply yet keeps its receipts under its last row.
 */
export function groupRows<T, Row, R>(
  items: readonly T[],
  partOf: (item: T) => RowPart<Row, R> | null,
  options: GroupOptions<T> = {},
): RowGroups<Row, R> {
  let groups = emptyGroups<Row, R>();
  items.forEach((item, index) => {
    const part = partOf(item);
    if (part === null) return;
    if (options.writingBefore?.(items, index) === true) groups = addPart(groups, { kind: 'writing' });
    groups = addPart(groups, part);
  });
  return settle(groups);
}

/** How a row reads for `withoutRepeatedCards`: someone's own words or a line about the chat, or Claude's reply. */
export type CardsRow = { kind: 'words' } | { kind: 'reply'; blocks: readonly RenderedBlock[] };

/** A card as it is drawn: its template, its fact and every word on it. */
function cardKey(block: RenderedBlock): string {
  return JSON.stringify([block.template, block.fact_id ?? null, block.title ?? null, block.text, block.lines ?? [], block.href ?? null, block.options ?? []]);
}

/**
 * Each reply's blocks without the cards an earlier reply in the same turn already drew, the same
 * card word for word, so a confirming reply's Booked card isn't drawn twice. Someone's own words or
 * a line about the chat start a new turn; a turn Claude started on its own, as the follow-up when a
 * booking closes a held request, doesn't. Display only: the signed messages and their checks are
 * as they were. Null for rows that aren't replies, in the rows' order.
 */
export function withoutRepeatedCards(rows: readonly CardsRow[]): (RenderedBlock[] | null)[] {
  let drawn = new Set<string>();
  return rows.map((row) => {
    if (row.kind === 'words') {
      drawn = new Set();
      return null;
    }
    return row.blocks.filter((block) => {
      if (block.kind !== 'card') return true;
      const key = cardKey(block);
      if (drawn.has(key)) return false;
      drawn.add(key);
      return true;
    });
  });
}
