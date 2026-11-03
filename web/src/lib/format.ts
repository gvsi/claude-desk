/**
 * How owner screens write times, amounts and the few lines built from them. Every time is read in
 * the business's time zone (its IANA name, `BusinessOut.timezone`), never the browser's: Mike's
 * morning is Los Angeles' morning wherever the reviewer sits. Visitor surfaces never use this file;
 * they show the kernel's text. The one exception is the mock checkout's amount, which the page
 * writes from the link's `amount_cents` with `formatMoneyExact`.
 */
import type { HoursWindow } from '../api/contracts.ts';
import type { ConversationSummary } from '../api/views.ts';

/** A moment on the business's clock: its local date and its 24-hour time. */
interface LocalTime {
  year: number;
  month: number;
  day: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
  /** "Monday". */
  weekday: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `at` on the business's clock. */
function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(part(type));
  const hour = number('hour');
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    // A runtime that writes midnight as 24 still means the start of the day.
    hour: Number.isInteger(hour) ? hour % 24 : 0,
    minute: number('minute'),
    weekday: part('weekday'),
  };
}

/** Today's greeting at `now` in the business's time zone: morning before 12, afternoon before 18, then evening. */
export function greetingFor(now: Date, timeZone: string): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const { hour } = localTime(now, timeZone);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** An amount in cents as the owner reads it: "$89", "$1,860", "$40.50". Whole dollars drop the cents. */
export function formatCents(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/**
 * An amount in cents as the mock checkout shows it, always with its cents: "$20.00", "$1,860.00".
 * Only the checkout uses it; cards and owner screens keep `formatCents`.
 */
export function formatMoneyExact(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** "10:46 am" from a local hour and minute. */
function clock({ hour, minute }: Pick<LocalTime, 'hour' | 'minute'>): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** `iso` as a date, or null when it isn't one (the clock can't read it, and nothing is made up). */
function readDate(iso: string): Date | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The time of `iso` on the business's clock: "10:46 am". A time that can't be read shows as nothing. */
export function formatClock(iso: string, timeZone: string): string {
  const at = readDate(iso);
  return at === null ? '' : clock(localTime(at, timeZone));
}

/**
 * The local date of `iso` on the business's clock, `YYYY-MM-DD` as the API writes a local date
 * (`ThisWeek.start`), or null for a time that can't be read.
 */
export function localDate(iso: string, timeZone: string): string | null {
  const at = readDate(iso);
  if (at === null) return null;
  const { year, month, day } = localTime(at, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * When something happened, on the business's clock: "Today, 9:52 am" on the business's current
 * date, else the date and the time, "Oct 26, 9:52 am". Never a bare date or a bare time.
 */
export function formatWhen(iso: string, timeZone: string, now: Date): string {
  const date = readDate(iso);
  if (date === null) return '';
  const at = localTime(date, timeZone);
  const today = localTime(now, timeZone);
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  const day = sameDay ? 'Today' : `${MONTHS[at.month - 1] ?? ''} ${at.day}`;
  return `${day}, ${clock(at)}`;
}

/** The date of `iso` on the business's clock: "Oct 27". A time that can't be read shows as nothing. */
export function formatDate(iso: string, timeZone: string): string {
  const at = readDate(iso);
  if (at === null) return '';
  const local = localTime(at, timeZone);
  return `${MONTHS[local.month - 1] ?? ''} ${local.day}`;
}

/**
 * A short day and time on the business's clock, as a booking's start reads in a list:
 * "Mon, Nov 2, 10:00 am". A time that can't be read shows as nothing.
 */
export function formatDayAndTime(iso: string, timeZone: string): string {
  const at = readDate(iso);
  if (at === null) return '';
  const local = localTime(at, timeZone);
  return `${local.weekday.slice(0, 3)}, ${MONTHS[local.month - 1] ?? ''} ${local.day}, ${clock(local)}`;
}

/** Whole days from `at`'s local date to `now`'s, on the business's clock: 0 today, 1 yesterday. */
function daysBefore(at: Date, now: Date, timeZone: string): number {
  const day = (t: LocalTime) => Date.UTC(t.year, t.month - 1, t.day);
  return Math.round((day(localTime(now, timeZone)) - day(localTime(at, timeZone))) / (24 * 60 * MINUTE_MS));
}

/** Where a conversation sits in the owner's list, by its local day. */
export type ConversationDay = 'Today' | 'Yesterday' | 'Earlier this week' | 'Earlier';

/**
 * The list group for `iso` on the business's clock: "Today", "Yesterday", "Earlier this week" for
 * the rest of the last 7 days (today included, as "Last 7 days" counts them), else "Earlier".
 */
export function conversationDay(iso: string, timeZone: string, now: Date): ConversationDay {
  const at = readDate(iso);
  if (at === null) return 'Earlier';
  const days = daysBefore(at, now, timeZone);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days <= 6 ? 'Earlier this week' : 'Earlier';
}

/**
 * A list row's time: the clock for today and yesterday, "10:46 am"; the weekday for the rest of the
 * last 7 days, as "Earlier this week" groups them, "Tue"; the date before that, "Oct 22".
 */
export function formatListTime(iso: string, timeZone: string, now: Date): string {
  const at = readDate(iso);
  if (at === null) return '';
  const local = localTime(at, timeZone);
  const days = daysBefore(at, now, timeZone);
  if (days <= 1) return clock(local);
  if (days <= 6) return local.weekday.slice(0, 3);
  return `${MONTHS[local.month - 1] ?? ''} ${local.day}`;
}

/** When a conversation started: "Today at 12:04 pm", "Yesterday at 10:10 pm", "Oct 27 at 9:52 am". */
export function formatStarted(iso: string, timeZone: string, now: Date): string {
  const at = readDate(iso);
  if (at === null) return '';
  const local = localTime(at, timeZone);
  const days = daysBefore(at, now, timeZone);
  const day = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${MONTHS[local.month - 1] ?? ''} ${local.day}`;
  return `${day} at ${clock(local)}`;
}

/**
 * A local date's weekday, "Mon", from its `YYYY-MM-DD`. The date is already the business's, so no
 * time zone applies. A string that isn't such a date is shown as it came.
 */
export function formatDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return WEEKDAYS[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()] ?? date;
}

const MINUTE_MS = 60_000;

/** How long ago `iso` was at `now`: "just now", "2 min ago", "1 hr ago", "3 days ago". */
export function relativeWait(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / MINUTE_MS);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** "1 person", "2 agents". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Who is talking to the Desk right now, from Today's live conversations: "Quiet right now.", "One
 * person is talking to your Desk right now.", "2 people and 1 agent are talking to your Desk right
 * now.", each part left out at zero. The owner's own chat as a customer is the owner, not someone
 * talking to the Desk, so it isn't counted.
 */
export function presenceLine(live: readonly Pick<ConversationSummary, 'kind' | 'owner_preview'>[]): string {
  const others = live.filter((s) => !s.owner_preview);
  const agents = others.filter((s) => s.kind === 'agent').length;
  const people = others.length - agents;
  if (people === 0 && agents === 0) return 'Quiet right now.';
  if (agents === 0) return people === 1 ? 'One person is talking to your Desk right now.' : `${people} people are talking to your Desk right now.`;
  if (people === 0) return agents === 1 ? 'One agent is talking to your Desk right now.' : `${agents} agents are talking to your Desk right now.`;
  return `${count(people, 'person', 'people')} and ${count(agents, 'agent', 'agents')} are talking to your Desk right now.`;
}

const NO_CALLBACK_TIME = "You'll call back. No time was promised.";

/**
 * The callback a visitor asked for, on the business's clock: a `<start>/<end>` window → "You'll
 * call back on Monday, between 8:00 am and 9:00 am."; none, or one that can't be read → "You'll
 * call back. No time was promised."
 */
export function callbackLine(window: string | null, timeZone: string): string {
  if (window === null) return NO_CALLBACK_TIME;
  const [start, end, ...rest] = window.split('/');
  if (start === undefined || end === undefined || rest.length > 0) return NO_CALLBACK_TIME;
  const from = readDate(start);
  const to = readDate(end);
  if (from === null || to === null) return NO_CALLBACK_TIME;
  const local = localTime(from, timeZone);
  return `You'll call back on ${local.weekday}, between ${clock(local)} and ${clock(localTime(to, timeZone))}.`;
}

/**
 * The one wording for a 422 `above_money_cap`, wherever a draft can meet it: the limit for taking
 * money without asking (`cap_cents`), or, when none is set, the step that comes first.
 */
export function aboveMoneyCapCopy(capCents: number | null): string {
  if (capCents === 0) return "You haven't set a limit for taking money without asking. Set one first.";
  if (capCents === null) return "That's above your limit for taking money without asking. Raise the limit first.";
  return `That's above your limit of ${formatCents(capCents)}. Raise the limit first.`;
}

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const;

/** "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Day `i` of the week, Monday first, by name: "Monday". */
const dayName = (i: number) => DAY_NAMES[WEEK[i] ?? 'mon'];

/**
 * A window's days as the boards say them: "Weekdays" (Monday to Friday), "Weekends", "Every day";
 * else each day by its plural name, Monday first ("Mondays, Wednesdays and Fridays"), three or more
 * in a row as a range ("Monday to Thursday"), with Monday to Friday as "Weekdays" and Saturday and
 * Sunday as "weekends" where they come with other days ("Weekdays and Saturdays", "Mondays and weekends").
 */
function daysWords(days: readonly string[]): string {
  const on = WEEK.map((day) => days.includes(day));
  if (on.every(Boolean)) return 'Every day';
  const parts: string[] = [];
  let from = 0;
  if (on.slice(0, 5).every(Boolean)) {
    parts.push('weekdays');
    from = 5;
  }
  for (let i = from; i < WEEK.length; i += 1) {
    if (!on[i]) continue;
    let end = i;
    while (end + 1 < WEEK.length && on[end + 1]) end += 1;
    if (i === 5 && end === 6) parts.push('weekends');
    else if (end - i >= 2) parts.push(`${dayName(i)} to ${dayName(end)}`);
    else for (let d = i; d <= end; d += 1) parts.push(`${dayName(d)}s`);
    i = end;
  }
  const words = listWords(parts);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A contract time of day ("18:00:00") as the owner reads it, "6:00 pm"; midnight as "midnight". Null when it can't be read. */
function timeOfDay(time: string): string | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  // Midnight only to the second: 00:00:30 is a clock time, so a window ending then isn't all day.
  const second = Number(match[3] ?? '0');
  return hour === 0 && minute === 0 && second === 0 ? 'midnight' : clock({ hour, minute });
}

/**
 * A window's two parts, in the business's own local times (a window carries no time zone of its
 * own): its days ("Weekdays", "Saturdays", "Mondays, Wednesdays and Fridays", `daysWords`) and its
 * times ("8:00 am to 6:00 pm", or "all day" from midnight to midnight). An end at 00:00 is midnight,
 * the day's end. A time that can't be read is shown as it came. `allDay` is true exactly when the
 * window runs from midnight to midnight, so a caller needn't compare `times` with its words.
 * Settings joins them with a space ("Weekdays 8:00 am to 6:00 pm"); `formatHours` with a comma.
 */
export function hoursParts(w: HoursWindow): { days: string; times: string; allDay: boolean } {
  const days = daysWords(w.days);
  const start = timeOfDay(w.start);
  const end = timeOfDay(w.end);
  if (start === 'midnight' && end === 'midnight') return { days, times: 'all day', allDay: true };
  return { days, times: `${start ?? w.start} to ${end ?? w.end}`, allDay: false };
}

/** A rule's hours in the boards' words: "Weekdays, 8:00 am to 6:00 pm", "Saturdays, 9:00 am to 1:00 pm", "Every day, all day". */
export function formatHours(w: HoursWindow): string {
  const { days, times } = hoursParts(w);
  return `${days}, ${times}`;
}

/** Stored booking windows as a sentence clause; no hours means no clause. */
export function bookingHoursWords(hours: readonly HoursWindow[]): string {
  return listWords(hours.map((window) => {
    const { days, times } = hoursParts(window);
    const lowered = /^(Weekdays|Weekends|Every day)\b/.test(days) ? `${days.charAt(0).toLowerCase()}${days.slice(1)}` : days;
    return `${lowered.startsWith('every day') ? '' : 'on '}${lowered}, ${times}`;
  }));
}
