/**
 * Owner-side formatting: every owner time is read in the business's time zone, never the browser's.
 */
import { describe, expect, it } from 'vitest';

import { greetingFor } from './format.ts';

const LA = 'America/Los_Angeles';

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
});
