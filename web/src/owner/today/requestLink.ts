/**
 * A held request opens its conversation when the loaded session is one the owner can read.
 * Otherwise its card on Today remains the destination, also supporting old bookmarked links.
 */
import type { NeedsYouSession } from '../../api/views.ts';
import { conversationPath } from '../conversations/status.ts';
import { todayPath } from '../useDesks.ts';

const PREFIX = '#request-';

/** Use only session metadata already read by the caller; owner-only chats cannot open here. */
export function requestPath(deskId: string, decisionId: string, session?: Pick<NeedsYouSession, 'session_id' | 'kind'> | null): string {
  const page = session?.session_id && session.kind !== 'owner' ? conversationPath(deskId, session.session_id) : todayPath(deskId);
  return `${page}${PREFIX}${encodeURIComponent(decisionId)}`;
}

/** The held request an address's hash names, or null when it names none or can't be read. */
export function requestInHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const decisionId = decodeURIComponent(hash.slice(PREFIX.length));
    return decisionId === '' ? null : decisionId;
  } catch {
    // A broken escape (`%E0%A4%A`) names nothing.
    return null;
  }
}
