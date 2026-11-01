import { describe, expect, it } from 'vitest';

import type { LedgerEvent } from './contracts.ts';
import { handoffEntryOf, takeoverEntryOf } from './handoffEntry.ts';

const entry = (kind: LedgerEvent['kind'], summary: unknown) => ({ kind, summary }) as Pick<LedgerEvent, 'kind' | 'summary'>;

describe('takeoverEntryOf', () => {
  it('distinguishes_takeover_from_handback_only_with_a_readable_direction', () => {
    expect(takeoverEntryOf(entry('takeover', { from: 'ai', to: 'owner' }))).toBe('takeover');
    expect(takeoverEntryOf(entry('takeover', { from: 'owner', to: 'ai' }))).toBe('handback');
    for (const summary of [undefined, null, [], 'owner to ai', {}, { mode: 'ai' }, { to: 'ai' }, { from: 'owner', to: 'unknown' }]) {
      expect(takeoverEntryOf(entry('takeover', summary))).toBeNull();
    }
    expect(takeoverEntryOf(entry('reply', { from: 'owner', to: 'ai' }))).toBeNull();
  });
});

describe('handoffEntryOf', () => {
  it('names_the_handoff_entries_as_the_kernel_writes_them', () => {
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], kind: 'card' }))).toBe('opened');
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'] }))).toBe('done');
    // The kernel closing one: a call-back that replaced it, the owner taking the chat over, the
    // owner writing in it, or the visitor booking a time in it.
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], replaced_by: 'h-2' }))).toBe('replaced');
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], closed_by: 'takeover' }))).toBe('took_over');
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], closed_by: 'owner_message' }))).toBe('wrote');
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], closed_by: 'booking' }))).toBe('booked');
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
    // A closing this build doesn't know, or that names two causes, is never called the owner's.
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], closed_by: 'expired' }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], closed_by: null }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], replaced_by: null }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], replaced_by: 'h-2', closed_by: 'takeover' }))).toBeNull();
    expect(handoffEntryOf(entry('desk_data', { part: 'handoffs', refs: ['h-1'], kind: 'card', closed_by: 'booking' }))).toBeNull();
  });
});
