// Fixtures for stories and tests: contract-shaped data for Turner Plumbing (the demo business,
// following the master plan's Turner seed), Chen & Co. CPA (the verification board and the
// business switcher) and Meridian Bay Permits (the public Desk on the city office's vision page).
// Everything a visitor would read is what the kernel would send: cards carry kernel-rendered text,
// and prose and status lines hold nothing a reply check would block. The one exception is two lines
// of Meridian's charter, a vision of what the templates could carry, which `meridian.ts` names.

import type { DemoInboxEntry, InboxNotice, RenderedBlock, SessionState, SseEvent } from '../../api/contracts';

/** The same fixture in both visitor languages. */
export interface Bilingual<T> {
  en: T;
  es: T;
}

/** A prose block: Claude's checked words, with no card data. */
export type ProseBlock = RenderedBlock & { kind: 'prose'; template: null };

/** One row of a conversation as the owner reads it. */
export type TranscriptTurn =
  /** What the visitor typed (shown as their bubble; user text). */
  | { kind: 'visitor'; text: string }
  /** A visiting agent's request (user text); `signed` when it carried a valid signature. */
  | { kind: 'agent'; text: string; signed: boolean }
  /** An owner whisper: only Claude sees it. */
  | { kind: 'whisper'; text: string }
  /** A stored SSE event: a message, a status receipt, or someone joining or leaving. */
  | { kind: 'event'; event: SseEvent };

export interface ConversationFixture {
  /** The name the owner sees in the conversation list. */
  name: string;
  session: SessionState;
  language: 'en' | 'es';
  turns: TranscriptTurn[];
}

/** The Demo inbox as the owner sees it: code-free notices, the entries behind them and display times. */
export interface DemoInboxFixture {
  notices: InboxNotice[];
  entries: DemoInboxEntry[];
  /** Times the owner's screen would show, keyed by `entry_id`; the design system formats none. */
  ownerTimes: Record<string, string>;
}

/**
 * A story's `requestHref` for an inbox entry: the place on the page of the held request its
 * `decision_id` names. As the kernel rules, only the owner's alert names one, so anything else (a
 * code, a checkpoint, an alert to someone else, an entry not fetched yet) gets no link, even if it
 * carries a `decision_id`. The owner app builds its own in-app path; the design system only needs
 * a place on the page.
 */
export function requestHrefOf(entry: DemoInboxEntry | null): string | undefined {
  if (entry?.kind !== 'alert' || entry.to !== 'owner' || !entry.decision_id) return undefined;
  return `#request-${encodeURIComponent(entry.decision_id)}`;
}

export { chen } from './chen';
export { meridian } from './meridian';
export type { CardData } from './rivera';
export { cardBlock, placeholderHex, proseBlock, rivera, RIVERA_MONEY_CAP_CENTS } from './rivera';
