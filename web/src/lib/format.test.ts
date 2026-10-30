/**
 * Owner-side formatting: every owner time is read in the business's time zone, never the browser's.
 */
import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../api/views.ts';
import {
  aboveMoneyCapCopy,
  callbackLine,
  formatCents,
  formatClock,
  formatDay,
  formatWhen,
  greetingFor,
  presenceLine,
  relativeWait,
} from './format.ts';

const LA = 'America/Los_Angeles';

/** A live conversation of `kind`, someone else's unless it is the owner's own preview. */
function live(kind: ConversationSummary['kind'], ownerPreview = false): ConversationSummary {
  return {
    session_id: `ses-${kind}-${ownerPreview ? 'preview' : 'web'}`,
    kind,
    display_name: null,
    verified: false,
    mode: 'ai',
    last_activity: '2026-10-30T17:00:00Z',
    outcome_counts: {},
    owner_preview: ownerPreview,
  };
}

describe('format', () => {
  it('greeting_by_local_hour', () => {
    // 2026-10-30 is daylight time in Los Angeles, seven hours behind UTC.
    const at = (iso: string) => new Date(iso);
    expect(greetingFor(at('2026-10-30T07:30:00Z'), LA)).toBe('Good morning'); // 00:30
    expect(greetingFor(at('2026-10-30T15:00:00Z'), LA)).toBe('Good morning'); // 08:00
    expect(greetingFor(at('2026-10-30T18:59:00Z'), LA)).toBe('Good morning'); // 11:59
    expect(greetingFor(at('2026-10-30T19:00:00Z'), LA)).toBe('Good afternoon'); // 12:00
    expect(greetingFor(at('2026-10-31T00:59:00Z'), LA)).toBe('Good afternoon'); // 17:59
    expect(greetingFor(at('2026-10-31T01:00:00Z'), LA)).toBe('Good evening'); // 18:00
    expect(greetingFor(at('2026-10-31T06:59:00Z'), LA)).toBe('Good evening'); // 23:59

    // The business's clock, not the browser's or UTC's: the same instant is evening in Madrid.
    expect(greetingFor(at('2026-10-30T17:30:00Z'), 'Europe/Madrid')).toBe('Good evening'); // 18:30
    expect(greetingFor(at('2026-10-30T17:30:00Z'), LA)).toBe('Good morning'); // 10:30
  });

  it('formats_cents', () => {
    expect(formatCents(8900)).toBe('$89');
    expect(formatCents(186_000)).toBe('$1,860');
    expect(formatCents(4050)).toBe('$40.50');
    expect(formatCents(37_800)).toBe('$378');
    expect(formatCents(0)).toBe('$0');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(1_000_000)).toBe('$10,000');
  });

  it('clock_in_the_business_time_zone', () => {
    expect(formatClock('2026-10-30T17:46:00Z', LA)).toBe('10:46 am');
    expect(formatClock('2026-10-30T19:05:00Z', LA)).toBe('12:05 pm');
    expect(formatClock('2026-10-30T07:00:00Z', LA)).toBe('12:00 am');
    expect(formatClock('2026-10-31T01:00:00Z', LA)).toBe('6:00 pm');
    // The kernel's microseconds and an offset of its own read the same.
    expect(formatClock('2026-10-30T17:46:00.123456Z', LA)).toBe('10:46 am');
    expect(formatClock('2026-10-30T10:46:00-07:00', LA)).toBe('10:46 am');
    // The same instant on Madrid's clock.
    expect(formatClock('2026-10-30T17:46:00Z', 'Europe/Madrid')).toBe('6:46 pm');
    // A time that can't be read shows as nothing rather than failing the screen.
    expect(formatClock('soon', LA)).toBe('');
  });

  it('when_says_today_or_the_date_with_the_time', () => {
    const now = new Date('2026-10-30T18:00:00Z');
    expect(formatWhen('2026-10-30T16:52:00Z', LA, now)).toBe('Today, 9:52 am');
    expect(formatWhen('2026-10-26T16:52:00Z', LA, now)).toBe('Oct 26, 9:52 am');
    // The day before in Los Angeles, though the same UTC date.
    expect(formatWhen('2026-10-30T06:30:00Z', LA, now)).toBe('Oct 29, 11:30 pm');
    // And the business's next day is not today, though it is the same UTC date as now.
    expect(formatWhen('2026-10-30T18:00:00Z', 'Pacific/Kiritimati', new Date('2026-10-30T09:00:00Z'))).toBe('Oct 31, 8:00 am');
    expect(formatWhen('soon', LA, now)).toBe('');
  });

  it('week_day_names', () => {
    expect(formatDay('2026-10-26')).toBe('Mon');
    expect(formatDay('2026-10-27')).toBe('Tue');
    expect(formatDay('2026-10-29')).toBe('Thu');
    expect(formatDay('2026-11-01')).toBe('Sun');
    // The day a date names, whatever the browser's clock: no time zone moves it.
    expect(formatDay('2026-03-08')).toBe('Sun');
  });

  it('presence_line_counts_people_and_agents', () => {
    expect(presenceLine([])).toBe('Quiet right now.');
    expect(presenceLine([live('visitor')])).toBe('One person is talking to your Desk right now.');
    expect(presenceLine([live('visitor'), live('visitor')])).toBe('2 people are talking to your Desk right now.');
    expect(presenceLine([live('agent')])).toBe('One agent is talking to your Desk right now.');
    expect(presenceLine([live('agent'), live('agent')])).toBe('2 agents are talking to your Desk right now.');
    expect(presenceLine([live('visitor'), live('visitor'), live('agent')])).toBe(
      '2 people and 1 agent are talking to your Desk right now.',
    );
    expect(presenceLine([live('visitor'), live('agent'), live('agent')])).toBe(
      '1 person and 2 agents are talking to your Desk right now.',
    );
    // The owner's own chat as a customer is the owner, not someone talking to the Desk.
    expect(presenceLine([live('visitor', true)])).toBe('Quiet right now.');
    expect(presenceLine([live('visitor', true), live('visitor')])).toBe('One person is talking to your Desk right now.');
  });

  it('relative_wait', () => {
    const now = new Date('2026-10-30T18:00:00Z');
    expect(relativeWait('2026-10-30T17:59:40Z', now)).toBe('just now');
    expect(relativeWait('2026-10-30T17:59:00Z', now)).toBe('1 min ago');
    expect(relativeWait('2026-10-30T17:58:00Z', now)).toBe('2 min ago');
    expect(relativeWait('2026-10-30T17:01:00Z', now)).toBe('59 min ago');
    expect(relativeWait('2026-10-30T17:00:00Z', now)).toBe('1 hr ago');
    expect(relativeWait('2026-10-30T13:30:00Z', now)).toBe('4 hr ago');
    expect(relativeWait('2026-10-29T18:00:00Z', now)).toBe('1 day ago');
    expect(relativeWait('2026-10-27T17:00:00Z', now)).toBe('3 days ago');
    // A clock a little ahead of the browser's is still just now.
    expect(relativeWait('2026-10-30T18:00:30Z', now)).toBe('just now');
  });

  it('callback_line_with_and_without_a_window', () => {
    // Monday, November 2, after the clocks go back: Los Angeles is eight hours behind UTC.
    expect(callbackLine('2026-11-02T08:00:00-08:00/2026-11-02T09:00:00-08:00', LA)).toBe(
      "You'll call back on Monday, between 8:00 am and 9:00 am.",
    );
    expect(callbackLine('2026-11-02T22:30:00Z/2026-11-02T23:30:00Z', LA)).toBe(
      "You'll call back on Monday, between 2:30 pm and 3:30 pm.",
    );
    expect(callbackLine(null, LA)).toBe("You'll call back. No time was promised.");
  });

  it('above_money_cap_copy', () => {
    expect(aboveMoneyCapCopy(50_000)).toBe("That's above your limit of $500. Raise the limit first.");
    expect(aboveMoneyCapCopy(4050)).toBe("That's above your limit of $40.50. Raise the limit first.");
    expect(aboveMoneyCapCopy(0)).toBe("You haven't set a limit for taking money without asking. Set one first.");
  });
});
