/**
 * How owner screens write times, amounts and the few lines built from them. Every time is read in
 * the business's time zone (its IANA name, `BusinessOut.timezone`), never the browser's: Maria's
 * morning is Los Angeles' morning wherever the reviewer sits. Visitor surfaces never use this file;
 * they show the kernel's text.
 */
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

/** "10:46 am" from a local hour and minute. */
function clock({ hour, minute }: Pick<LocalTime, 'hour' | 'minute'>): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** The time of `iso` on the business's clock: "10:46 am". */
export function formatClock(iso: string, timeZone: string): string {
  return clock(localTime(new Date(iso), timeZone));
}

/**
 * When something happened, on the business's clock: "Today, 9:52 am" on the business's current
 * date, else the date and the time, "Oct 26, 9:52 am". Never a bare date or a bare time.
 */
export function formatWhen(iso: string, timeZone: string, now: Date): string {
  const at = localTime(new Date(iso), timeZone);
  const today = localTime(now, timeZone);
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  const day = sameDay ? 'Today' : `${MONTHS[at.month - 1] ?? ''} ${at.day}`;
  return `${day}, ${clock(at)}`;
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
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NO_CALLBACK_TIME;
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
