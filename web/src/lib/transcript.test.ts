import { describe, expect, it } from 'vitest';

import type { EvMessage, StatusEvent } from '../api/contracts.ts';
import type { TranscriptItem } from '../api/views.ts';
import { proseBlock, rivera } from '../ds/fixtures/index.ts';
import { addPart, emptyGroups, opensAReply, withoutRepeatedCards } from './transcript.ts';

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

  describe('a card drawn once per turn', () => {
    const booked = rivera.blocks.booking_confirmed.en;
    const words = proseBlock('Your booking is confirmed.');

    it('a_repeated_card_in_the_same_turn_is_dropped', () => {
      // The confirming reply draws the Booked card, then a second reply in the same turn draws it again.
      expect(withoutRepeatedCards([{ kind: 'words' }, { kind: 'reply', blocks: [words, booked] }, { kind: 'reply', blocks: [booked] }])).toEqual([
        null,
        [words, booked],
        [],
      ]);
    });

    it('a_turn_claude_started_on_its_own_is_still_the_same_turn', () => {
      // The follow-up when a booking closes a held request has no one's words before it.
      const follow = proseBlock('That earlier request is closed now.');
      expect(withoutRepeatedCards([{ kind: 'reply', blocks: [booked] }, { kind: 'reply', blocks: [follow, booked] }])).toEqual([[booked], [follow]]);
    });

    it('two_different_cards_are_both_drawn', () => {
      const other = { ...booked, fact_id: 'booking:B-78', title: 'Wednesday, November 4' };
      expect(withoutRepeatedCards([{ kind: 'reply', blocks: [booked] }, { kind: 'reply', blocks: [other] }])).toEqual([[booked], [other]]);
    });

    it('the_same_fact_with_other_words_is_drawn_again', () => {
      // A quote for the same fact at a new price is a new card, not a repeat.
      const quote = rivera.blocks.quote.en;
      const revised = { ...quote, lines: [...(quote.lines ?? []), '20% off'] };
      expect(withoutRepeatedCards([{ kind: 'reply', blocks: [quote] }, { kind: 'reply', blocks: [revised] }])).toEqual([[quote], [revised]]);
    });

    it('a_card_repeated_in_a_later_turn_is_drawn', () => {
      expect(withoutRepeatedCards([{ kind: 'reply', blocks: [booked] }, { kind: 'words' }, { kind: 'reply', blocks: [booked] }])).toEqual([
        [booked],
        null,
        [booked],
      ]);
    });

    it('words_are_never_dropped', () => {
      expect(withoutRepeatedCards([{ kind: 'reply', blocks: [words] }, { kind: 'reply', blocks: [words] }])).toEqual([[words], [words]]);
    });
  });
});
