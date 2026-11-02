/**
 * The chat each payment link came from, so the paid or cancelled checkout can link back to it. The API can't
 * say which Desk a link's token belongs to, so the public chat notes it in this browser as it shows
 * a payment link card: a digest of the link's token and the chat's own path, `/d/<slug>`, and
 * nothing else (no query, so an owner's `?preview=` stays out). The token pays or cancels its link,
 * so it is never stored. One record, the newest `PAY_CHATS_MAX` links.
 *
 * Only a public chat's path is ever written or read back: anything else stored under the key (by
 * another build, an extension, a person at the console) reads as no chat, so the checkout's link
 * can only lead to a chat on this site. Storage that is empty, blocked or holds something else
 * gives no chat, and the checkout says what it said before, with no link.
 */
import { readLocal, writeLocal } from './storage.ts';

/** The most links the record keeps: the newest. */
export const PAY_CHATS_MAX = 20;

/** A payment link's token, as a payment link card's `/pay/<token>` carries it. */
const TOKEN = /^[A-Za-z0-9_-]+$/;

/** A public chat's own path: `/d/` and a Desk's slug, nothing before or after. */
const CHAT_PATH = /^\/d\/[a-z0-9-]+$/;

/** A token's digest, as `payChatKey` writes it. */
const KEY = /^[0-9a-z]{1,11}$/;

/** One link's token digest and the path of the chat that showed it. */
type Entry = readonly [key: string, path: string];

/** True for an entry as `recordPayChat` writes one: a token's digest and a public chat's path. */
function isEntry(value: unknown): value is Entry {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string' &&
    KEY.test(value[0]) &&
    CHAT_PATH.test(value[1])
  );
}

/**
 * The record as stored, oldest first, keeping only its entries. Nothing stored, a record that isn't
 * a list, or storage that can't be read: none.
 */
function entries(): Entry[] {
  const raw = readLocal('payChats');
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/**
 * Notes that the chat at `path` showed the payment link `token`, as the newest entry. Anything but
 * a token and a public chat's path is never stored. The record keeps the newest `PAY_CHATS_MAX`
 * links: the oldest goes first.
 */
export function recordPayChat(token: string, path: string): void {
  if (!TOKEN.test(token)) return;
  const key = payChatKey(token);
  const entry: Entry = [key, path];
  if (!isEntry(entry)) return;
  const kept = entries();
  const newest = kept.at(-1);
  if (newest?.[0] === key && newest[1] === path) return;
  const next = [...kept.filter(([known]) => known !== key), entry];
  writeLocal('payChats', JSON.stringify(next.slice(-PAY_CHATS_MAX)));
}

/**
 * The record's key for a token: a short one-way digest (cyrb53, 53 bits in base 36), so the record
 * never holds a token that could pay or cancel its link. Among the newest twenty links, two sharing
 * a digest is too unlikely to matter, and even then the checkout could only link to a public chat.
 */
export function payChatKey(token: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The path of the public chat that showed the payment link `token`, or null. */
export function payChatFor(token: string): string | null {
  if (!TOKEN.test(token)) return null;
  const key = payChatKey(token);
  return entries().find(([known]) => known === key)?.[1] ?? null;
}
