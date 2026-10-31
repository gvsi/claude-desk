/**
 * A still copy of what a new copy of Rivera Plumbing's Today reads, for the preview behind the
 * intro dialog, which draws Today itself from it. It holds the Rivera seed as a new copy opens on
 * it: the business and its Main line Desk, Alex Kim's assistant's chat (a visiting agent's quote and
 * deposit, about 40 minutes before), the seeded hold (a visitor not on record asking for 15% off, 12
 * minutes before), Dana's chat (live, booked, with Maria's whisper) and the reply the check stopped,
 * the briefing and the last 7 days they make, and the hold's alert in the Demo inbox. The
 * held request and the names come from the design system's Rivera fixtures; times are counted back
 * from `now`. Nothing here is read from the API: no copy exists yet.
 */
import type { QueryKey } from '@tanstack/react-query';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import type { BusinessOut, ConversationSummary, DeskSummary, NeedsYouItem, Today } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { firstName, needsYouKey, OWNER_INBOX_KEY, todayKey } from '../useDesks.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TIMEZONE = 'America/Los_Angeles';

/** How long before a new copy opens its seeded hold came in. */
const HELD_MINUTES_AGO = 12;

/** The booking Dana made in her chat, in the kernel's words for the owner. */
const DANA_BOOKED = 'A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.';

/** A preview's own ids: a copy's are only known once it exists. */
const DESK_ID = 'preview-desk';

export interface StillToday {
  business: BusinessOut;
  desk: DeskSummary;
  /** The conversations live now, which the sidebar counts beside Conversations. */
  liveCount: number;
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

/** The business's offset from UTC at `ms`, as the API writes it: `-07:00`. */
function offsetAt(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'longOffset' }).formatToParts(ms);
  const name = parts.find((p) => p.type === 'timeZoneName');
  const offset = name?.value.replace('GMT', '') ?? '';
  return offset === '' ? '+00:00' : offset;
}

/** Rivera's Today, Needs you and Demo inbox as a new copy opened at `now` reads them. */
export function stillToday(now: Date): StillToday {
  const at = now.getTime();
  const iso = (minutesAgo: number) => new Date(at - minutesAgo * MINUTE).toISOString();
  const held = rivera.decisions.held;
  const heldAt = iso(HELD_MINUTES_AGO);
  const visitorTurn = rivera.conversations.visitor.turns.find((t) => t.kind === 'visitor');
  const danaSession = rivera.conversations.danaLive.session.session_id;
  const agent = rivera.conversations.alexAgent;
  const today = localDate(at);

  const desk: DeskSummary = {
    desk_id: DESK_ID,
    slug: rivera.business.slug,
    name: rivera.business.deskName,
    business_name: rivera.business.name,
    hours: [],
    answering: true,
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
    last_activity: iso(0),
    outcome_counts: { executed: 3 },
    owner_preview: false,
  };

  const todayRead: Today = {
    greeting_name: firstName(rivera.business.ownerName),
    needs_you_count: 1,
    live: [dana],
    briefing: {
      // From 18:00 yesterday; drawn only on a night with nothing in it, which this isn't.
      since: `${addDays(today, -1)}T18:00:00${offsetAt(at)}`,
      conversations: 3,
      bookings: 1,
      leads: 0,
      blocked: 1,
      total: 3,
      newest: {
        // The reply the check stopped in the held visitor's chat: a price in Claude's own words.
        blocked: { kind: 'blocked', at: heldAt, session_id: held.session_id, display_name: null, ref_id: 'preview-stopped-reply', line: null },
        booking: { kind: 'booking', at: iso(0), session_id: danaSession, display_name: null, ref_id: 'preview-booking', line: DANA_BOOKED },
        // Claude's last answer in Alex Kim's assistant's chat, which held nothing else.
        lead_or_answer: { kind: 'answer', at: iso(39), session_id: agent.session.session_id, display_name: agent.name, ref_id: agent.session.session_id, line: null },
      },
    },
    this_week: {
      timezone: TIMEZONE,
      start: addDays(today, -6),
      end: today,
      bookings: 1,
      booked_cents: 18_000,
      conversations: 3,
      // Maria whispered in Dana's chat; Claude handled the agent's and the held visitor's alone.
      handled: 2,
      stepped_in: 1,
      stopped: 1,
      days: [-6, -5, -4, -3, -2, -1, 0].map((offset) =>
        offset === 0
          ? { date: today, conversations: 3, bookings: 1, stopped: 1 }
          : { date: addDays(today, offset), conversations: 0, bookings: 0, stopped: 0 },
      ),
    },
  };

  const needsYou: NeedsYouItem[] = [
    {
      decision: held,
      handoff: null,
      held_by: rivera.ruleCards['rv-quote'].reason,
      held_at: heldAt,
      session: { session_id: held.session_id, kind: 'visitor', display_name: null, verified: false, assurance: 'none' },
      from_the_visitor: visitorTurn?.kind === 'visitor' ? visitorTurn.text : null,
    },
  ];

  const inbox: DemoInboxEntry[] = [
    { entry_id: 'preview-alert', to: 'owner', kind: 'alert', body: held.reason_plain, created_at: heldAt, decision_id: held.decision_id },
  ];

  return {
    business,
    desk,
    liveCount: todayRead.live.length,
    reads: [
      [todayKey(DESK_ID), todayRead],
      [needsYouKey(DESK_ID), needsYou],
      [OWNER_INBOX_KEY, inbox],
    ],
  };
}
