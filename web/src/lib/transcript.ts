/**
 * How a conversation's items become rows with their receipts attached, shared by the visitor's
 * chat and the owner's conversation view. A row is someone's message or a line about the chat; a
 * receipt is a checkpoint result that attaches under a row.
 *
 * A turn starts with someone's own words (a visitor's message, an agent's request, a whisper) and
 * ends with Claude's reply. The receipts of the actions Claude ran in that turn reach the stream
 * before the reply does, and they attach under the reply, after the reply's own check, because the
 * reply is the message they explain. Any receipt after a reply attaches to the last row; one before
 * any row is kept as `leading`.
 */

export interface GroupedRow<Row, R> {
  item: Row;
  /** The receipts attached under the row, in order. */
  receipts: R[];
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
  /** A checkpoint result. */
  | { kind: 'receipt'; receipt: R };

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
    case 'receipt':
      if (groups.awaitingReply) return { ...groups, pending: [...groups.pending, part.receipt] };
      return attach(groups, [part.receipt]);
  }
}

/**
 * Rows for a stored conversation, in the items' order. `partOf` reads each item (null skips it).
 * The result is settled: a turn that has no reply yet keeps its receipts under its last row.
 */
export function groupRows<T, Row, R>(items: readonly T[], partOf: (item: T) => RowPart<Row, R> | null): RowGroups<Row, R> {
  let groups = emptyGroups<Row, R>();
  for (const item of items) {
    const part = partOf(item);
    if (part !== null) groups = addPart(groups, part);
  }
  return settle(groups);
}
