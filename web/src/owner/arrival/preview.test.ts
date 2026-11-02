/**
 * The preview's still copy against a new copy of the mock's Turner seed: what Today draws from each
 * read must be the same, so the dialog leaves onto the Today it showed. The copy's opening and the
 * moment Today reads it are chosen apart, as they fall apart in the app: Today reads the copy as it
 * opens, a moment later, or a minute later. Near midnight, part of the seed happened yesterday on
 * the business's clock and part today; near a minute's end, a clock time is a moment from the next
 * minute's.
 */
import { describe, expect, it } from 'vitest';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import type { BriefingItem, NeedsYouItem, Today } from '../../api/views.ts';
import { formatClock, formatDay, formatWhen, relativeWait } from '../../lib/format.ts';
import { needsYou, today } from '../../mocks/readModels.ts';
import { seedWorld } from '../../mocks/seed.ts';
import { MockWorld } from '../../mocks/world.ts';
import { needsYouKey, OWNER_INBOX_KEY, todayKey } from '../useDesks.ts';
import { previewClock, stillToday } from './preview.ts';

const TIMEZONE = 'America/Los_Angeles';
const SECOND = 1_000;

interface Reads {
  today: Today;
  needsYou: NeedsYouItem[];
  inbox: DemoInboxEntry[];
}

/** What a new copy of the mock's Turner seed, opened at `opened`, reads at `readAt`. */
function mockCopy(opened: number, readAt: number): Reads {
  const world = new MockWorld('rivera', 1, () => 'k7Hq2vX9');
  world.at(opened, () => seedWorld(world));
  const desk = world.desk(world.ids.deskId);
  if (!desk) throw new Error('the seed has its main Desk');
  return world.at(readAt, () => ({ today: today(world, desk), needsYou: needsYou(world, desk), inbox: world.inbox.map((r) => r.entry) }));
}

/** What the preview holds for a copy opened at `opened`, read at `readAt`, by read. */
function preview(opened: number, readAt: number): Reads {
  const { desk, reads } = stillToday(new Date(opened), new Date(readAt));
  const read = <T>(key: readonly unknown[]): T => {
    const found = reads.find(([k]) => JSON.stringify(k) === JSON.stringify(key));
    if (!found) throw new Error(`the preview holds no ${JSON.stringify(key)}`);
    return found[1] as T;
  };
  return {
    today: read<Today>(todayKey(desk.desk_id)),
    needsYou: read<NeedsYouItem[]>(needsYouKey(desk.desk_id)),
    inbox: read<DemoInboxEntry[]>(OWNER_INBOX_KEY),
  };
}

/**
 * What Today draws from its reads: every count, time and line, without the ids each side makes up
 * and the briefing's start, which is drawn only on a night with nothing in it. Times are compared
 * as instants: the mock writes them to the microsecond, the preview to the millisecond.
 */
function drawn({ today: t, needsYou: held, inbox }: Reads) {
  const when = (iso: string | null) => (iso === null ? null : new Date(Date.parse(iso)).toISOString());
  const event = (item: BriefingItem | null) => item && { kind: item.kind, at: when(item.at), display_name: item.display_name, line: item.line, cause: item.cause };
  return {
    greeting_name: t.greeting_name,
    needs_you_count: t.needs_you_count,
    live: t.live.map((s) => ({
      kind: s.kind,
      display_name: s.display_name,
      verified: s.verified,
      mode: s.mode,
      last_activity: when(s.last_activity),
      outcome_counts: s.outcome_counts,
      latest_visitor_text: s.latest_visitor_text,
    })),
    briefing: {
      conversations: t.briefing.conversations,
      bookings: t.briefing.bookings,
      leads: t.briefing.leads,
      answers: t.briefing.answers,
      turned_down: t.briefing.turned_down,
      total: t.briefing.total,
      newest: {
        turned_down: event(t.briefing.newest.turned_down),
        booking: event(t.briefing.newest.booking),
        lead_or_answer: event(t.briefing.newest.lead_or_answer),
      },
    },
    this_week: t.this_week,
    needs_you: held.map((item) => ({ held_at: when(item.held_at), held_by: item.held_by, from_the_visitor: item.from_the_visitor, reason: item.decision?.reason_plain })),
    inbox: inbox.map((entry) => ({ to: entry.to, kind: entry.kind, body: entry.body, created_at: when(entry.created_at) })),
  };
}

/**
 * The words Today puts on its reads' times when it draws them at `now`, as Today formats them: each
 * held request's wait ("12 min ago"), the briefing's rows ("Today, 11:58 pm"), Live now's clock times,
 * the Demo inbox's times, and each of the last 7 days by name with its counts.
 */
function shown({ today: t, needsYou: held, inbox }: Reads, now: number) {
  const at = new Date(now);
  const newest = t.briefing.newest;
  return {
    waiting: held.map((item) => (item.held_at === null ? null : relativeWait(item.held_at, at))),
    briefing: [newest.turned_down, newest.booking, newest.lead_or_answer].map((item) => item && formatWhen(item.at, TIMEZONE, at)),
    live: t.live.map((s) => formatClock(s.last_activity, TIMEZONE)),
    inbox: inbox.map((entry) => formatWhen(entry.created_at, TIMEZONE, at)),
    days: t.this_week.days.map((day) => `${formatDay(day.date)} ${day.date}: ${day.conversations} conversations, ${day.bookings} bookings`),
  };
}

/** When the copy opens, on the business's clock. */
const OPENINGS = [
  ['on an ordinary afternoon', '2026-10-30T13:59:59-07:00'],
  ['half a minute before midnight, so a minute later Today reads it on a new day', '2026-10-30T23:59:30-07:00'],
  ['59.9 s past a minute, so the hold comes 0.05 s after one', '2026-10-30T14:07:59.900-07:00'],
  ["with Alex Kim's assistant's chat across midnight", '2026-10-31T00:39:19-07:00'],
  ['just after midnight, with all of it yesterday', '2026-10-31T00:00:29-07:00'],
  ["with Dana's chat across midnight", '2026-10-31T00:02:59-07:00'],
  ['with the held message just before midnight and the reply the check stopped just after', '2026-10-31T00:11:59.800-07:00'],
] as const;

/** How long after the copy opens Today reads it: at once, a moment later, a minute later. */
const READ_AFTER = [0, 2 * SECOND, 60.2 * SECOND] as const;

describe('The preview behind the intro dialog', () => {
  describe.each(OPENINGS)('a copy opened %s', (_when, at) => {
    const opened = Date.parse(at);
    it.each(READ_AFTER)('preview_reads_as_a_new_copy_does: read %d ms after it opened', (after) => {
      const readAt = opened + after;
      const still = preview(opened, readAt);
      const copy = mockCopy(opened, readAt);
      expect(drawn(still)).toEqual(drawn(copy));
      expect(shown(still, readAt)).toEqual(shown(copy, readAt));
    });
  });

  it('preview_redrawn_as_the_copy_opens_shows_what_today_will', () => {
    // The page was drawn half a minute before midnight, and the passcode opened the copy a minute
    // and a half later: Dana's booking came just after midnight, and the hold 0.05 s after a minute.
    const drawnAt = Date.parse('2026-10-30T23:59:30-07:00');
    const opened = Date.parse('2026-10-31T00:00:59.900-07:00');
    // The preview as the page draws it again once the copy has answered, labels and all.
    const { opened: from, readAt } = previewClock(drawnAt, opened);
    const still = preview(from.getTime(), readAt.getTime());
    // Today as it opens onto the copy, read ahead and handed off a moment after the copy answered.
    const todayReadAt = opened + 2 * SECOND;
    expect(shown(still, readAt.getTime())).toEqual(shown(mockCopy(opened, todayReadAt), todayReadAt));
    // Until the copy opened, the preview read its copy as the page was drawn.
    expect(previewClock(drawnAt, null).readAt.getTime()).toBe(drawnAt);
  });
});
