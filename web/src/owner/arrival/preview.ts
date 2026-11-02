/**
 * A still copy of what a new copy of Turner Plumbing's Today reads, for the preview behind the
 * intro dialog, which draws Today itself from it. It holds the Turner seed as a new copy opens on
 * it: the business and its Main line Desk, Alex Kim's assistant's chat (a visiting agent's quote and
 * deposit, about 40 minutes before), the seeded hold (a visitor not on record asking for 15% off, 12
 * minutes before) with the reply the check stopped (on Safety, so in no read here), Dana's chat
 * (live, booked, with Mike's whisper), the briefing and the last 7 days they make, and the hold's
 * alert in Notifications, unread. The held request, the names and the rules that word the held
 * card's rule come from the design system's Turner fixtures. Each part of the seed is dated back
 * from when the copy opened as the seed dates it, and counted on its own day on the business's
 * clock as Today reads it, so just after midnight what happened before it is yesterday's. Nothing
 * here is read from the API: no copy exists yet.
 */
import type { QueryKey } from '@tanstack/react-query';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import type { BusinessOut, ConversationSummary, DeskSummary, NeedsYouItem, RulesView, Today } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { requestRulesQuery } from '../rules/requestRulesQuery.ts';
import { firstName, needsYouKey, OWNER_INBOX_KEY, todayKey } from '../useDesks.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TIMEZONE = 'America/Los_Angeles';

/**
 * When each part of the seed happened, in ms before a new copy opens, as the seed dates it: the
 * agent's steps 20 s apart, a visitor's turn's steps 150 ms apart, Dana's turns two minutes apart.
 */
const SEEDED = {
  /** Alex Kim's assistant's two messages, 20 s apart from its chat's start 40 minutes before, and Claude's last answer. */
  agentMessages: [39 * MINUTE + 40_000, 39 * MINUTE],
  agentAnswered: 38 * MINUTE + 40_000,
  /** The held visitor's message, and its hold (when the owner's alert came too). */
  heldMessage: 12 * MINUTE,
  held: 12 * MINUTE - 150,
  /** Dana's three messages, the booking in her last turn, and that turn's end. */
  danaMessages: [5 * MINUTE, 2 * MINUTE + 59_400, 38_800],
  booked: 38_650,
  danaLast: 38_200,
} as const;

/**
 * How long after a new copy opens its Today is read and drawn, at the least: Today waits for its
 * reads. The preview draws the copy as Today will, that long after it opened, so a time counted back
 * reads the same: the hold, 11 min 59.85 s before the copy opened, is "12 min ago" on both.
 */
export const READ_AFTER_OPENING_MS = 1_000;

/** When the preview takes its copy to have opened, and when it reads it and draws its labels. */
export interface PreviewClock {
  opened: Date;
  readAt: Date;
}

/**
 * The preview's clock, for a page drawn at `drawnAt` (a `Date.now()` time): once the copy has
 * answered, `openedAt`, this page's closest reading of when it opened, so the picture the dialog
 * leaves onto is dated as the copy is; until then, a copy that opened as the page was drawn. Either
 * way it is read `READ_AFTER_OPENING_MS` after it opened, as Today reads it.
 */
export function previewClock(drawnAt: number, openedAt: number | null): PreviewClock {
  const opened = openedAt ?? drawnAt - READ_AFTER_OPENING_MS;
  return { opened: new Date(opened), readAt: new Date(opened + READ_AFTER_OPENING_MS) };
}

/** The booking Dana made in her chat, in the kernel's words for the owner. */
const DANA_BOOKED = 'A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.';

/** The offset written on the briefing's start, which the preview never draws. */
const SINCE_OFFSET = '-07:00';

/** A preview's own ids: a copy's are only known once it exists. */
const DESK_ID = 'preview-desk';

export interface StillToday {
  business: BusinessOut;
  desk: DeskSummary;
  /** The conversations live now, which the sidebar counts beside Conversations. */
  liveCount: number;
  /** The notifications the owner hasn't seen, which the sidebar counts beside Notifications. */
  unreadCount: number;
  /** What each of Today's reads answers, by the read's key. */
  reads: (readonly [QueryKey, unknown])[];
}

/** The local `YYYY-MM-DD` of `ms` on the business's clock. */
function localDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** The local date `days` after `date`. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Turner's Today, Needs you and notifications as Today reads them at `readAt`, for a new copy that opened at `opened`. */
export function stillToday(opened: Date, readAt: Date): StillToday {
  // The seed is dated back from when the copy opened; the business's today is the one Today reads it on.
  const from = opened.getTime();
  const iso = (msAgo: number) => new Date(from - msAgo).toISOString();
  const dateOf = (msAgo: number) => localDate(from - msAgo);
  const held = rivera.decisions.held;
  const heldAt = iso(SEEDED.held);
  const visitorTurn = rivera.conversations.visitor.turns.find((t) => t.kind === 'visitor');
  const danaSession = rivera.conversations.danaLive.session.session_id;
  // What Dana wrote last, which Live now quotes: her chat's newest message, as the seed replays it.
  const danaSaid = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : [])).at(-1) ?? null;
  const agent = rivera.conversations.alexAgent;
  const today = localDate(readAt.getTime());

  const desk: DeskSummary = {
    desk_id: DESK_ID,
    slug: rivera.business.slug,
    name: rivera.business.deskName,
    business_name: rivera.business.name,
    hours: [],
    answering: true,
    setup: null,
    business_type: 'rivera',
  };
  const business: BusinessOut = {
    business_id: 'preview-business',
    name: rivera.business.name,
    owner_display_name: rivera.business.ownerName,
    timezone: TIMEZONE,
    desks: [desk],
  };

  const dana: ConversationSummary = {
    session_id: danaSession,
    kind: 'visitor',
    display_name: null,
    verified: false,
    mode: 'ai',
    last_activity: iso(SEEDED.danaLast),
    outcome_counts: { executed: 3 },
    owner_preview: false,
    latest_visitor_text: danaSaid,
  };

  const todayRead: Today = {
    greeting_name: firstName(rivera.business.ownerName),
    needs_you_count: 1,
    live: [dana],
    briefing: {
      // From 18:00 yesterday. It is drawn only on a night with nothing in it, which this isn't, so
      // the offset is Pacific daylight time's, fixed, rather than one the browser is asked to name:
      // older Safari can't name one.
      since: `${addDays(today, -1)}T18:00:00${SINCE_OFFSET}`,
      conversations: 3,
      bookings: 1,
      leads: 0,
      // Claude answered Alex Kim's assistant's chat on its own, the night's one answer.
      answers: 1,
      // The seed refused nothing. The reply the check stopped in the held visitor's chat stays on
      // Safety, and a chat with a hold isn't one Claude answered.
      turned_down: 0,
      total: 2,
      newest: {
        turned_down: null,
        booking: { kind: 'booking', at: iso(SEEDED.booked), session_id: danaSession, display_name: null, ref_id: 'preview-booking', line: DANA_BOOKED, cause: null },
        // Claude's last answer in Alex Kim's assistant's chat, which held nothing else.
        lead_or_answer: {
          kind: 'answer',
          at: iso(SEEDED.agentAnswered),
          session_id: agent.session.session_id,
          display_name: agent.name,
          ref_id: agent.session.session_id,
          line: null,
          cause: null,
        },
      },
    },
    this_week: {
      timezone: TIMEZONE,
      start: addDays(today, -6),
      end: today,
      bookings: 1,
      booked_cents: 18_000,
      conversations: 3,
      // Mike whispered in Dana's chat; Claude handled the agent's and the held visitor's alone.
      handled: 2,
      stepped_in: 1,
      // Only a refused request counts as stopped here, and the seed has none: the reply the check
      // stopped is Safety's, not the week's.
      stopped: 0,
      // Each on its own day: a conversation counts on each day it has a message in.
      days: [-6, -5, -4, -3, -2, -1, 0].map((offset) => {
        const date = addDays(today, offset);
        const on = (msAgo: number) => dateOf(msAgo) === date;
        return {
          date,
          conversations: Number(SEEDED.agentMessages.some(on)) + Number(on(SEEDED.heldMessage)) + Number(SEEDED.danaMessages.some(on)),
          bookings: Number(on(SEEDED.booked)),
          stopped: 0,
        };
      }),
    },
  };

  const needsYou: NeedsYouItem[] = [
    {
      decision: held,
      handoff: null,
      // Past the list-price quote card's limit: no ask card held it, so Needs you names no rule's
      // reason; its card names that quote rule's hold line from the rules (`rules` below).
      held_by: null,
      held_at: heldAt,
      session: { session_id: held.session_id, kind: 'visitor', display_name: null, verified: false, assurance: 'none' },
      from_the_visitor: visitorTurn?.kind === 'visitor' ? visitorTurn.text : null,
    },
  ];

  // The seed's own rules, which the held card's "Your rule" box is worded from (`useRequestRules`):
  // only their cards are read, so the version's hashes are left empty.
  const rules: RulesView = {
    active: {
      desk_id: DESK_ID,
      version: 1,
      parent_version: null,
      cards: Object.values(rivera.ruleCards).map((card) => ({ ...card })),
      cedar_sha256: '',
      schema_sha256: '',
      baseline_sha256: '',
      profiles_sha256: '',
      invariants_sha256: '',
      review_thresholds_version: 1,
      status: 'active',
    },
    tools: [],
    preset: null,
  };

  const inbox: DemoInboxEntry[] = [
    {
      entry_id: 'preview-alert',
      to: 'owner',
      kind: 'alert',
      body: held.reason_plain,
      created_at: heldAt,
      decision_id: held.decision_id,
      title: 'A request needs your answer',
    },
  ];

  return {
    business,
    desk,
    liveCount: todayRead.live.length,
    // A new copy's notifications, all unread: nothing in it has been seen.
    unreadCount: inbox.length,
    reads: [
      [todayKey(DESK_ID), todayRead],
      [needsYouKey(DESK_ID), needsYou],
      [requestRulesQuery(DESK_ID).queryKey, rules],
      [OWNER_INBOX_KEY, inbox],
    ],
  };
}
