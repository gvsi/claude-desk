/** Board 14's compact local hours and prices, built from structured values, and the lines' labels. */
import type { PublicHoursWindow } from '../api/views.ts';
import { cardChrome } from '../ds/index.ts';
import { formatCents } from '../lib/format.ts';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function time(value: string): string {
  const [hour, minute] = value.split(':').map(Number);
  return `${hour! % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour! < 12 ? 'am' : 'pm'}`;
}

export function formatPublicHours(window: PublicHoursWindow): string {
  const days: string[] = [];
  for (let start = 0; start < DAYS.length; start += 1) {
    if (!window.days.includes(DAYS[start]!)) continue;
    let end = start;
    while (end + 1 < DAYS.length && window.days.includes(DAYS[end + 1]!)) end += 1;
    days.push(end === start ? NAMES[start]! : `${NAMES[start]}–${NAMES[end]}`);
    start = end;
  }
  return `${days.join(', ')}, ${time(window.start)} – ${time(window.end)}`;
}

export function formatPublicPrice(item: { title: string; unit_cents: number }): string {
  return `${item.title}, ${formatCents(item.unit_cents)}`;
}

/** A public line's label, as the public About panel shows it: the app's own words, known before the lines are read. */
export function publicLineLabel(key: string): string | undefined {
  return cardChrome(key === 'contact' ? 'contact' : 'policy', 'en', `charter:${key}`)?.label;
}
