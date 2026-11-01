import { describe, expect, it } from 'vitest';

import type { EvMessage, StatusEvent } from '../api/contracts.ts';
import type { TranscriptItem } from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { addPart, emptyGroups, opensAReply } from './transcript.ts';

describe('transcript grouping', () => {
  it('approved_receipt_is_a_later_answer_and_does_not_open_a_reply', () => {
    const [held, , reply] = rivera.events.heldTurn as [StatusEvent, unknown, EvMessage];
    const approved: StatusEvent = { ...held, type: 'receipt', state: 'approved' };
    const items: TranscriptItem[] = [
      { n: 1, kind: 'status', created_at: '', text: null, event: approved },
      { n: 2, kind: 'delivered', created_at: '', text: null, event: reply },
    ];
    expect(opensAReply(items, 0)).toBe(false);
  });

  it.each(['row', 'pending', 'leading'] as const)('beside_appends_but_after_inserts_in_%s', (place) => {
    let groups = emptyGroups<string, string>();
    if (place === 'row') groups = addPart(groups, { kind: 'reply', row: 'reply', receipt: null });
    if (place === 'pending') groups = addPart(groups, { kind: 'writing' });
    groups = addPart(groups, { kind: 'receipt', receipt: 'first' });
    groups = addPart(groups, { kind: 'receipt', receipt: 'second' });
    const beside = addPart(groups, { kind: 'receipt', receipt: 'outcome', beside: 'first' });
    const after = addPart(groups, { kind: 'receipt', receipt: 'outcome', after: 'first' });
    const receipts = (result: typeof groups) => place === 'row' ? result.rows[0]?.receipts : result[place];
    expect(receipts(beside)).toEqual(['first', 'second', 'outcome']);
    expect(receipts(after)).toEqual(['first', 'outcome', 'second']);
  });
});
