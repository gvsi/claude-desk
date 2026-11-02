/**
 * The preview's still copy against a new copy of the mock's Turner seed opened at the same moment:
 * what Today draws from each read must be the same, so the dialog leaves onto the Today it showed.
 * Near midnight, part of the seed happened yesterday on the business's clock and part today.
 */
import { describe, expect, it } from 'vitest';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import type { BriefingItem, NeedsYouItem, Today } from '../../api/views.ts';
import { needsYou, today } from '../../mocks/readModels.ts';
import { seedWorld } from '../../mocks/seed.ts';
import { MockWorld } from '../../mocks/world.ts';
import { needsYouKey, OWNER_INBOX_KEY, todayKey } from '../useDesks.ts';
import { READ_AFTER_OPENING_MS, stillToday } from './preview.ts';

/** What a new copy of the mock's Turner seed reads at `ms`, opened as Today is, a moment before it is read. */
function mockCopyAt(ms: number): { today: Today; needsYou: NeedsYouItem[]; inbox: DemoInboxEntry[] } {
  const world = new MockWorld('rivera', 1, () => 'k7Hq2vX9');
  world.at(ms - READ_AFTER_OPENING_MS, () => seedWorld(world));
  const desk = world.desk(world.ids.deskId);
  if (!desk) throw new Error('the seed has its main Desk');
  return world.at(ms, () => ({ today: today(world, desk), needsYou: needsYou(world, desk), inbox: world.inbox.map((r) => r.entry) }));
}

/** What the preview holds at `ms`, by read. */
function previewAt(ms: number): { today: Today; needsYou: NeedsYouItem[]; inbox: DemoInboxEntry[] } {
  const { desk, reads } = stillToday(new Date(ms));
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
function drawn({ today: t, needsYou: held, inbox }: { today: Today; needsYou: NeedsYouItem[]; inbox: DemoInboxEntry[] }) {
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
    inbox: inbox.map((entry) => ({ to: entry.to, kind: entry.kind, title: entry.title ?? null, body: entry.body, created_at: when(entry.created_at) })),
  };
}

describe('The preview behind the intro dialog', () => {
  it.each([
    ['an ordinary afternoon', '2026-10-30T14:00:00-07:00'],
    ["with Alex Kim's assistant's chat across midnight", '2026-10-31T00:39:20-07:00'],
    ['just after midnight, with all of it yesterday', '2026-10-31T00:00:30-07:00'],
    ["with Dana's chat across midnight", '2026-10-31T00:03:00-07:00'],
    ['with the held message just before midnight and the reply the check stopped just after', '2026-10-31T00:12:00.800-07:00'],
  ])('preview_reads_as_a_new_copy_does: %s', (_when, at) => {
    const ms = Date.parse(at);
    expect(drawn(previewAt(ms))).toEqual(drawn(mockCopyAt(ms)));
  });
});
