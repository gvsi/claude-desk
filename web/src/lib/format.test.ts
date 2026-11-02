/**
 * Owner-side formatting: every owner time is read in the business's time zone, never the browser's.
 */
import { describe, expect, it } from 'vitest';

import type { HoursWindow } from '../api/contracts.ts';
import type { ConversationSummary } from '../api/views.ts';
import {
  aboveMoneyCapCopy,
  callbackLine,
  conversationDay,
  formatCents,
  formatClock,
  formatDay,
  formatDayAndTime,
  formatHours,
  formatListTime,
  formatMoneyExact,
  formatStarted,
  formatWhen,
  formatDate,
  greetingFor,
  hoursParts,
  localDate,
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
  it('conversation_days_on_the_business_clock', () => {
    // Thursday, October 29, 10:30 am in Los Angeles.
    const now = new Date('2026-10-29T17:30:00Z');
    expect(conversationDay('2026-10-29T07:00:00Z', LA, now)).toBe('Today'); // 00:00 today
    expect(conversationDay('2026-10-29T06:59:00Z', LA, now)).toBe('Yesterday'); // 23:59 yesterday
    expect(conversationDay('2026-10-28T07:00:00Z', LA, now)).toBe('Yesterday');
    expect(conversationDay('2026-10-28T06:59:00Z', LA, now)).toBe('Earlier this week'); // Oct 27
    expect(conversationDay('2026-10-23T07:00:00Z', LA, now)).toBe('Earlier this week'); // Oct 23, the first of the last 7 days
    expect(conversationDay('2026-10-23T06:59:00Z', LA, now)).toBe('Earlier'); // Oct 22
    expect(conversationDay('not a time', LA, now)).toBe('Earlier');

    // Today and yesterday show the time, the rest of the last 7 days the weekday, anything older the date.
    expect(formatListTime('2026-10-29T17:20:00Z', LA, now)).toBe('10:20 am');
    expect(formatListTime('2026-10-29T05:10:00Z', LA, now)).toBe('10:10 pm');
    expect(formatListTime('2026-10-27T17:20:00Z', LA, now)).toBe('Tue');
    expect(formatListTime('2026-10-23T07:00:00Z', LA, now)).toBe('Fri'); // the first of the last 7 days
    expect(formatListTime('2026-10-23T06:59:00Z', LA, now)).toBe('Oct 22');
    expect(formatListTime('nope', LA, now)).toBe('');

    // When a conversation started: "Today at 12:04 pm", "Yesterday at 10:10 pm", "Oct 27 at 9:52 am".
    expect(formatStarted('2026-10-29T19:04:00Z', LA, new Date('2026-10-29T20:00:00Z'))).toBe('Today at 12:04 pm');
    expect(formatStarted('2026-10-29T05:10:00Z', LA, now)).toBe('Yesterday at 10:10 pm');
    expect(formatStarted('2026-10-27T16:52:00Z', LA, now)).toBe('Oct 27 at 9:52 am');
    expect(formatStarted('nope', LA, now)).toBe('');
  });

  it('day_and_time_on_the_business_clock', () => {
    // A booking's start, short enough for the list: "Mon, Nov 2, 10:00 am".
    expect(formatDayAndTime('2026-11-02T18:00:00Z', LA)).toBe('Mon, Nov 2, 10:00 am');
    expect(formatDayAndTime('2026-10-31T06:30:00Z', LA)).toBe('Fri, Oct 30, 11:30 pm'); // still the 30th there
    expect(formatDayAndTime('2026-11-03T22:00:00Z', 'America/New_York')).toBe('Tue, Nov 3, 5:00 pm');
    expect(formatDayAndTime('nope', LA)).toBe('');
  });

  it('local_date_on_the_business_clock', () => {
    expect(localDate('2026-10-29T07:00:00Z', LA)).toBe('2026-10-29'); // 00:00 on the 29th in Los Angeles
    expect(localDate('2026-10-29T06:59:59Z', LA)).toBe('2026-10-28'); // still the 28th there, the 29th in UTC
    expect(localDate('2026-10-24T03:00:00.000000Z', LA)).toBe('2026-10-23'); // as the API writes its times
    expect(localDate('2026-11-01T09:30:00Z', LA)).toBe('2026-11-01'); // after the clocks went back
    expect(localDate('2026-10-29T06:59:59Z', 'UTC')).toBe('2026-10-29');
    expect(localDate('not a time', LA)).toBeNull();
  });

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

  it('checkout_amount_keeps_the_cents', () => {
    // The mock checkout always writes the cents, as a payment page does; cards keep formatCents.
    expect(formatMoneyExact(2000)).toBe('$20.00');
    expect(formatMoneyExact(4050)).toBe('$40.50');
    expect(formatMoneyExact(186_000)).toBe('$1,860.00');
    expect(formatMoneyExact(5)).toBe('$0.05');
    expect(formatMoneyExact(1_000_000)).toBe('$10,000.00');
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

  it('date_on_the_business_clock', () => {
    expect(formatDate('2026-10-27T17:00:00Z', LA)).toBe('Oct 27');
    // The day before in Los Angeles, though the same UTC date.
    expect(formatDate('2026-10-30T06:30:00Z', LA)).toBe('Oct 29');
    expect(formatDate('soon', LA)).toBe('');
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

  it('hours_parts_name_the_days_and_the_times', () => {
    const parts = (days: string[], start = '08:00:00', end = '18:00:00') => hoursParts({ days, start, end } as HoursWindow);
    const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

    // The boards' words: the days as the owner says them, then the times.
    expect(parts(WEEKDAYS)).toEqual({ days: 'Weekdays', times: '8:00 am to 6:00 pm', allDay: false });
    expect(parts(['sat'], '09:00:00', '13:00:00')).toEqual({ days: 'Saturdays', times: '9:00 am to 1:00 pm', allDay: false });
    expect(parts(['sun']).days).toBe('Sundays');
    expect(parts(['sun', 'sat']).days).toBe('Weekends');
    expect(parts([...WEEKDAYS, 'sat', 'sun']).days).toBe('Every day');
    // Other sets: each day by its plural name, in the week's order, Monday first.
    expect(parts(['fri', 'mon', 'wed']).days).toBe('Mondays, Wednesdays and Fridays');
    expect(parts(['tue', 'thu']).days).toBe('Tuesdays and Thursdays');
    expect(parts(['mon']).days).toBe('Mondays');
    // Three days or more in a row read as a range; weekdays and weekends keep their names.
    expect(parts(['mon', 'tue', 'wed', 'thu']).days).toBe('Monday to Thursday');
    expect(parts(['fri', 'sat', 'sun']).days).toBe('Friday to Sunday');
    expect(parts([...WEEKDAYS, 'sat']).days).toBe('Weekdays and Saturdays');
    expect(parts([...WEEKDAYS, 'sun']).days).toBe('Weekdays and Sundays');
    expect(parts(['mon', 'sat', 'sun']).days).toBe('Mondays and weekends');

    // A day's end at 00:00 is midnight; midnight to midnight is all day.
    expect(parts(WEEKDAYS, '08:00:00', '00:00:00').times).toBe('8:00 am to midnight');
    expect(parts(WEEKDAYS, '00:00:00', '00:00:00').times).toBe('all day');
    expect(parts(WEEKDAYS, '12:00:00', '12:30:00').times).toBe('12:00 pm to 12:30 pm');
    expect(parts(WEEKDAYS, '07:05:00', '23:59:00').times).toBe('7:05 am to 11:59 pm');
    // A time that can't be read is shown as it came.
    expect(parts(WEEKDAYS, '25:00:00', '18:00:00').times).toBe('25:00:00 to 6:00 pm');

    // Settings joins several windows with no comma after the days.
    const opening = [parts(WEEKDAYS), parts(['sat'], '09:00:00', '13:00:00')].map(({ days, times }) => `${days} ${times}`).join(', ');
    expect(opening).toBe('Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm');
  });

  it('hours_parts_say_when_a_window_is_all_day', () => {
    const parts = (start: string, end: string) => hoursParts({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start, end } as HoursWindow);
    // Midnight to midnight, and only that, is all day, so a caller needn't read the words.
    expect(parts('00:00:00', '00:00:00')).toEqual({ days: 'Weekdays', times: 'all day', allDay: true });
    expect(parts('00:00', '00:00')).toMatchObject({ allDay: true });
    expect(parts('08:00:00', '00:00:00')).toMatchObject({ times: '8:00 am to midnight', allDay: false });
    expect(parts('00:00:00', '18:00:00')).toMatchObject({ times: 'midnight to 6:00 pm', allDay: false });
    expect(parts('00:00:00', '23:59:00')).toMatchObject({ allDay: false });
    // A time is midnight only when its seconds are zero too; otherwise it reads as a clock time.
    expect(parts('00:00:00', '00:00:30')).toEqual({ days: 'Weekdays', times: 'midnight to 12:00 am', allDay: false });
    expect(parts('00:00:30', '00:00:00')).toEqual({ days: 'Weekdays', times: '12:00 am to midnight', allDay: false });
    // A time that can't be read is never all day.
    expect(parts('24:00:00', '00:00:00')).toMatchObject({ times: '24:00:00 to midnight', allDay: false });
  });

  it('format_hours_joins_its_parts', () => {
    const hours = (days: string[], start: string, end: string) => formatHours({ days, start, end } as HoursWindow);
    expect(hours(['mon', 'tue', 'wed', 'thu', 'fri'], '08:00:00', '18:00:00')).toBe('Weekdays, 8:00 am to 6:00 pm');
    expect(hours(['sat'], '09:00:00', '13:00:00')).toBe('Saturdays, 9:00 am to 1:00 pm');
    expect(hours(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], '00:00:00', '00:00:00')).toBe('Every day, all day');
  });
});
