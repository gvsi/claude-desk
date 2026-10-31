import { describe, expect, it } from 'vitest';

import type { LedgerEvent } from './contracts.ts';
import { handoffEntryOf } from './handoffEntry.ts';

const entry = (kind: LedgerEvent['kind'], summary: unknown) => ({ kind, summary }) as Pick<LedgerEvent, 'kind' | 'summary'>;

describe('handoffEntryOf', () => {
  it('names_the_two_handoff_entries_as_the_kernel_writes_them', () => {
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], kind: 'card' }))).toBe('opened');
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'] }))).toBe('done');
  });

  it('leaves_every_other_entry_alone', () => {
    // A handoffs entry whose kind is null or unknown, another part, another kind of entry, and a
    // summary that isn't an object.
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], kind: null }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], kind: 'callback' }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'calendar' }))).toBeNull();
    expect(handoffEntryOf(entry('execute', { part: 'handoffs', refs: ['h-1'] }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', null))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', ['handoffs']))).toBeNull();
  });
});
