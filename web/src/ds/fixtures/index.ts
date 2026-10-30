// Fixtures for stories and tests: contract-shaped data for Rivera Plumbing (the demo business,
// following the master plan's Rivera seed) and Chen & Co. CPA (the verification board and the
// business switcher). Everything a visitor would read is what the kernel would send: cards carry
// kernel-rendered text, and prose and status lines hold nothing a reply check would block.

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
 * `decision_id` names, or nothing when it names none or isn't fetched yet. The owner app builds its
 * own in-app path; the design system only needs a place on the page.
 */
export function requestHrefOf(entry: DemoInboxEntry | null): string | undefined {
  const decisionId = entry?.decision_id;
  return decisionId ? `#request-${encodeURIComponent(decisionId)}` : undefined;
}

export { chen } from './chen';
export type { CardData } from './rivera';
export { cardBlock, placeholderHex, proseBlock, rivera, RIVERA_MONEY_CAP_CENTS } from './rivera';
