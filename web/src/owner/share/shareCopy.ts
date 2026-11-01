/**
 * The share kit's words: the Desk's public link as people type it and as a voicemail reads it out,
 * and the ready-made words an owner pastes where customers already look, each naming that link and
 * saying that Claude, an AI, answers there (N-Run2-Share).
 */
import type { CopyListItem } from '../../ds/index.ts';
import { afterName } from '../../lib/names.ts';

/**
 * A link under the API's paths, a card's single-use document link among them. Such a link is never
 * shared: a messaging app that unfurled it would spend it.
 */
const API_PATH = /\/api\//i;

/** Refuses a link under the API's paths, so no document link reaches words that get pasted. */
function notUnderTheApi(url: string): string {
  if (API_PATH.test(url)) throw new Error('Only the Desk’s public link is shared.');
  return url;
}

/** The link as people type it: no scheme and no closing slash, "desk.example/rivera". */
export function displayLink(url: string): string {
  try {
    const link = new URL(url);
    return `${link.host}${link.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/** The link as a voicemail reads it out: "desk.example slash rivera". */
export function spokenLink(url: string): string {
  return displayLink(url).split('/').join(' slash ');
}

/**
 * The three ready-made words for `business`'s Desk at `url`, in N-Run2-Share's words: for a Google
 * profile, an email signature and a voicemail, each naming the link and that Claude, an AI,
 * answers; the voicemail adds that `ownerName` calls back about an emergency. The email signature
 * leaves out the board's opening question, "Need a plumber?", which names a trade the Desk's data
 * doesn't have. A link under the API's paths, a document link among them, throws.
 */
export function SHARE_COPY(business: string, ownerName: string, url: string): CopyListItem[] {
  const link = displayLink(notUnderTheApi(url));
  return [
    { title: 'Google profile', text: `Questions, quotes and bookings, any time: ${link}. Answered by Claude, an AI, under ${ownerName}’s rules.` },
    { title: 'Email signature', text: `Ask ${business} any time at ${link} (answered by Claude, an AI).` },
    {
      title: 'Voicemail',
      text: `You’ve reached ${business}${afterName(business, `. For quotes and bookings, visit ${spokenLink(url)}, where Claude, an AI, answers any time. For an emergency, leave a message and ${ownerName} will call you back.`)}`,
    },
  ];
}
