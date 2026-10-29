/**
 * How owner screens write times and amounts. Every time is read in the business's time zone (its
 * IANA name, `BusinessOut.timezone`), never the browser's: Maria's morning is Los Angeles' morning
 * wherever the reviewer sits. Visitor surfaces never use this file; they show the kernel's text.
 */

/** The hour, 0 to 23, at `now` in `timeZone`. */
function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  // A runtime that writes midnight as 24 still means the start of the day.
  return Number.isInteger(hour) ? hour % 24 : 0;
}

/** Today's greeting at `now` in the business's time zone: morning before 12, afternoon before 18, then evening. */
export function greetingFor(now: Date, timeZone: string): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const hour = localHour(now, timeZone);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
