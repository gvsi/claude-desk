/**
 * What the owner has seen of their notifications, kept in this browser: the entries the page last
 * showed, held in the page when storage takes no write.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { forgetSeen, markSeen, seenIds } from './seen.ts';

const KEY = 'claude-desk.notifications-seen';

beforeEach(() => {
  forgetSeen();
});

afterEach(() => {
  vi.restoreAllMocks();
  forgetSeen();
});

it('marks_what_the_page_showed_and_drops_an_earlier_copys', () => {
  markSeen(['old-copy-entry']);
  expect([...seenIds()]).toEqual(['old-copy-entry']);
  // A new copy's page shows its own entries: they replace what was kept.
  markSeen(['entry-b', 'entry-a']);
  expect([...seenIds()].sort()).toEqual(['entry-a', 'entry-b']);
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual(['entry-a', 'entry-b']);
});

it('keeps_what_was_seen_when_storage_takes_no_write', () => {
  // Storage still reads an older value, but refuses the new one (full, or blocked).
  localStorage.setItem(KEY, JSON.stringify(['old']));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  markSeen(['old', 'new']);
  expect([...seenIds()].sort()).toEqual(['new', 'old']);
});

it('reads_nothing_seen_from_a_broken_value', () => {
  localStorage.setItem(KEY, '{not json');
  expect(seenIds().size).toBe(0);
  localStorage.setItem(KEY, JSON.stringify({ ids: ['a'] }));
  expect(seenIds().size).toBe(0);
});
