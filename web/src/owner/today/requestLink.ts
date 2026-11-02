/**
 * Where a held request opens in the owner app: its card on its Desk's Today, at
 * `/app/<desk>/today#request-<decision id>`. The owner's Notifications page links a hold's alert there, and
 * Today brings the card into view and focus when its address names one.
 */
import { todayPath } from '../useDesks.ts';

const PREFIX = '#request-';

/** The held request `decisionId` on the Today of `deskId`. */
export function requestPath(deskId: string, decisionId: string): string {
  return `${todayPath(deskId)}${PREFIX}${encodeURIComponent(decisionId)}`;
}

/** The held request a Today address's hash names, or null when it names none or can't be read. */
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
