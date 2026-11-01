import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAY_CHATS_MAX, payChatFor, payChatKey, recordPayChat } from './payChats.ts';

/** Where the public chat keeps the chats its payment links came from, as `storage.ts` names it. */
const PAY_CHATS = 'claude-desk.pay-chats';
const CHAT = '/d/turner-plumbing-abc123';

/** The record as stored: each link's token and its chat's path, oldest first. */
const stored = () => JSON.parse(localStorage.getItem(PAY_CHATS) ?? 'null') as unknown;

describe('the chats payment links came from', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('records_a_link_against_its_chat', () => {
    recordPayChat('tok_A-1', CHAT);
    expect(stored()).toEqual([[payChatKey('tok_A-1'), CHAT]]);
    expect(payChatFor('tok_A-1')).toBe(CHAT);

    // Another link joins it, newest last; the same link again stores nothing twice.
    recordPayChat('tok_B-2', '/d/rivera-emergencies-abc123');
    recordPayChat('tok_B-2', '/d/rivera-emergencies-abc123');
    expect(stored()).toEqual([
      [payChatKey('tok_A-1'), CHAT],
      [payChatKey('tok_B-2'), '/d/rivera-emergencies-abc123'],
    ]);
    expect(payChatFor('tok_A-1')).toBe(CHAT);
    expect(payChatFor('tok_B-2')).toBe('/d/rivera-emergencies-abc123');

    // An older link shown again moves to the newest place, keeping its chat.
    recordPayChat('tok_A-1', CHAT);
    expect(stored()).toEqual([
      [payChatKey('tok_B-2'), '/d/rivera-emergencies-abc123'],
      [payChatKey('tok_A-1'), CHAT],
    ]);
  });

  it('never_stores_the_token', () => {
    // A link's token pays or cancels it, so the record keeps only a digest of it, never the token.
    recordPayChat('tok_A-1', CHAT);
    expect(localStorage.getItem(PAY_CHATS)).not.toContain('tok_A-1');
    expect(stored()).toEqual([[payChatKey('tok_A-1'), CHAT]]);
    expect(payChatKey('tok_A-1')).toMatch(/^[0-9a-z]{1,11}$/);
    expect(payChatFor('tok_A-1')).toBe(CHAT);
  });

  it('keeps_the_newest_twenty', () => {
    expect(PAY_CHATS_MAX).toBe(20);
    const tokens = Array.from({ length: 25 }, (_, i) => `tok${i}`);
    for (const token of tokens) recordPayChat(token, CHAT);
    // The five oldest went; the twenty newest stay, oldest first.
    expect(stored()).toEqual(tokens.slice(5).map((token) => [payChatKey(token), CHAT]));
    for (const token of tokens.slice(0, 5)) expect(payChatFor(token), token).toBeNull();
    for (const token of tokens.slice(5)) expect(payChatFor(token), token).toBe(CHAT);

    // A link shown again is the newest, so it outlives one more new link; the oldest after it goes.
    recordPayChat('tok5', CHAT);
    recordPayChat('tok25', CHAT);
    expect(payChatFor('tok5')).toBe(CHAT);
    expect(payChatFor('tok6')).toBeNull();
    expect(stored()).toHaveLength(20);
  });

  it('reads_only_its_own_token', () => {
    // Nothing stored: no chat.
    expect(payChatFor('tok_A-1')).toBeNull();

    // Another link's entry gives this one nothing, nor does a token that only starts or ends like it.
    recordPayChat('tok_B-2', CHAT);
    for (const token of ['tok_A-1', 'tok_B', 'tok_B-23', 'ok_B-2', 'TOK_B-2', '', '0', 'length', 'constructor', '__proto__']) {
      expect(payChatFor(token), token).toBeNull();
    }
    expect(payChatFor('tok_B-2')).toBe(CHAT);

    // A record that isn't one: no chat, and a new link replaces it with a record of its own.
    for (const raw of ['not json', '{"tok_B-2":"/d/rivera"}', '"tok_B-2"', '[["tok_B-2"]]', '[["tok_B-2", 7]]', '[null, 1, "x"]', 'null']) {
      localStorage.setItem(PAY_CHATS, raw);
      expect(payChatFor('tok_B-2'), raw).toBeNull();
      recordPayChat('tok_C-3', CHAT);
      expect(stored(), raw).toEqual([[payChatKey('tok_C-3'), CHAT]]);
    }
    // Entries that aren't a token and a path are dropped; the rest still read.
    localStorage.setItem(PAY_CHATS, JSON.stringify([[payChatKey('tok_B-2'), CHAT, 'extra'], 5, [payChatKey('tok_C-3'), CHAT]]));
    expect(payChatFor('tok_B-2')).toBeNull();
    expect(payChatFor('tok_C-3')).toBe(CHAT);
    // An entry under the token itself, as an earlier build wrote it, reads as no chat.
    localStorage.setItem(PAY_CHATS, JSON.stringify([['tok_C-3', CHAT]]));
    expect(payChatFor('tok_C-3')).toBeNull();
    recordPayChat('tok_C-3', CHAT);

    // Storage that can't be read or written: no chat, and nothing throws.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked.', 'SecurityError');
    });
    expect(payChatFor('tok_C-3')).toBeNull();
    expect(() => recordPayChat('tok_D-4', CHAT)).not.toThrow();
  });

  /** Anything but a public chat's own path, `/d/<slug>`: another site, a query, another page. */
  const BAD_PATHS = [
    'https://evil.example/d/rivera',
    '//evil.example',
    '/\\evil.example',
    '/d//evil.example',
    'javascript:alert(1)',
    '/d/rivera?preview=desk-1',
    '/d/rivera#about',
    '/d/rivera/agents',
    '/d/rivera/',
    '/d/Turner',
    '/d/rivera plumbing',
    '/d/rivera%2F..',
    '/d/rivera\n',
    ' /d/rivera',
    '/d/',
    '/d',
    '/pay/tok_B-2',
    '/app/desk-1',
    '',
  ];

  it('rejects_a_bad_path', () => {
    // Recording one stores nothing.
    for (const path of BAD_PATHS) {
      recordPayChat('tok_B-2', path);
      expect(localStorage.getItem(PAY_CHATS), JSON.stringify(path)).toBeNull();
    }
    // Nor does a token that isn't one a payment link card carries.
    for (const token of ['', 'tok/B', 'tok B', 'tok?x=1', '../x']) {
      recordPayChat(token, CHAT);
      expect(localStorage.getItem(PAY_CHATS), JSON.stringify(token)).toBeNull();
    }

    // One stored by anything else reads as no chat, while a good entry beside it still reads.
    for (const path of BAD_PATHS) {
      localStorage.setItem(PAY_CHATS, JSON.stringify([[payChatKey('tok_B-2'), path], [payChatKey('tok_C-3'), CHAT]]));
      expect(payChatFor('tok_B-2'), JSON.stringify(path)).toBeNull();
      expect(payChatFor('tok_C-3')).toBe(CHAT);
    }
  });
});
