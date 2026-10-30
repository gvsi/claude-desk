/**
 * The τ³-Banking data behind the capability prediction's chart, held to what the prediction says. The chart
 * claims nothing the text doesn't: each date and score it draws is written out here and checked against the
 * leaderboard rows, and the fits are computed from those rows, as the text says they were.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_SCORES,
  LEADERBOARD,
  TAU3_BAR,
  TAU3_FITS,
  TAU3_SOURCE,
  TOP_SCORE,
  bestSoFar,
  dayOf,
  logOddsFit,
  monthYear,
} from './tau3.ts';

const DAY = 24 * 60 * 60 * 1000;
const PREDICTION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/capability-prediction.md');

/** How far `date` is from the day `iso`, in days. */
function daysFrom(date: Date, iso: string): number {
  return Math.abs(date.getTime() - Date.parse(`${iso}T00:00:00Z`)) / DAY;
}

describe('the τ³-Banking chart data', () => {
  it('leaderboard_rows_keep_their_listed_names', () => {
    // Every pass^1 row, in the leaderboard's order, under the name it lists: GPT-5.2 appears twice, once per
    // configuration, under the same name.
    expect(LEADERBOARD.map((row) => `${row.model} ${row.score}`)).toEqual([
      'Qwen 3.8 Max 55.2',
      'Claude Opus 5 48.7',
      'Grok 4.5 47.9',
      'GPT-5.6-sol 46.9',
      'GPT-5.5 44.6',
      'Muse Spark 1.1 40.5',
      'Claude Opus 4.7 40.2',
      'Claude Opus 4.8 39.7',
      'Claude Fable 5 39.7',
      'GPT-5.4 39.4',
      'Kimi K3 37.1',
      'GLM-5.2 37.1',
      'GPT-5.2 32.2',
      'Gemini 3 Flash 27.3',
      'Claude Opus 4.6 27.3',
      'Gemini 3.1 Pro Preview 26',
      'Claude Sonnet 4.5 25.3',
      'Inkling 25',
      'Claude Opus 4.5 24.7',
      'Gemini 3 Pro 18',
      'Grok 4.2 18',
      'Grok 4 fast 15.7',
      'Gemini 2.5 Pro 13.7',
      'Grok 4.1 fast 13.1',
      'GPT-5.2 12.6',
      'GLM-5 9.8',
      'Qwen3.5-397B-A17B 9.8',
    ]);
  });

  it('fits_cross_the_bar_when_the_text_says', () => {
    const claude = LEADERBOARD.filter((row) => row.model.startsWith('Claude '));
    const opus = claude.filter((row) => row.model.startsWith('Claude Opus '));
    expect(claude).toHaveLength(7);
    expect(opus.map((row) => row.model)).toEqual([
      'Claude Opus 5',
      'Claude Opus 4.7',
      'Claude Opus 4.8',
      'Claude Opus 4.6',
      'Claude Opus 4.5',
    ]);
    // Each release that set a new top score, in release order.
    expect(bestSoFar(LEADERBOARD).map((row) => `${row.model} ${row.score}`)).toEqual([
      'Gemini 2.5 Pro 13.7',
      'Grok 4 fast 15.7',
      'Claude Sonnet 4.5 25.3',
      'GPT-5.2 32.2',
      'GPT-5.4 39.4',
      'Claude Opus 4.7 40.2',
      'GPT-5.5 44.6',
      'GPT-5.6-sol 46.9',
      'Grok 4.5 47.9',
      'Qwen 3.8 Max 55.2',
    ]);

    // "between April 2027 (the best score across labs) and October 2027 (all seven Claude models); the five
    // Opus scores give June 2027"
    expect(daysFrom(logOddsFit(bestSoFar(LEADERBOARD)).crosses(0.8), '2027-04-20')).toBeLessThan(1);
    expect(daysFrom(logOddsFit(opus).crosses(0.8), '2027-06-12')).toBeLessThan(1);
    expect(daysFrom(logOddsFit(claude).crosses(0.8), '2027-10-03')).toBeLessThan(1);
  });

  it('chart_claims_are_the_predictions', () => {
    const text = readFileSync(PREDICTION, 'utf8');
    for (const claim of ['24.7%', '48.7%', '55.2%', 'April 2027', 'June 2027', 'October 2027']) {
      expect(text, claim).toContain(claim);
    }

    // The bar.
    expect(text).toContain('The bar is 80% pass^1');
    expect(TAU3_BAR).toBe(0.8);

    // The seven Claude scores, by release, run from 24.7 (Opus 4.5) to 48.7 (Opus 5).
    expect(CLAUDE_SCORES.map((row) => `${row.model} ${row.released} ${row.score}`)).toEqual([
      'Claude Sonnet 4.5 2025-09-29 25.3',
      'Claude Opus 4.5 2025-11-24 24.7',
      'Claude Opus 4.6 2026-02-05 27.3',
      'Claude Opus 4.7 2026-04-16 40.2',
      'Claude Opus 4.8 2026-05-28 39.7',
      'Claude Fable 5 2026-06-09 39.7',
      'Claude Opus 5 2026-07-24 48.7',
    ]);
    const lowest = CLAUDE_SCORES.reduce((a, b) => (b.score < a.score ? b : a));
    const highest = CLAUDE_SCORES.reduce((a, b) => (b.score > a.score ? b : a));
    expect([lowest.model, lowest.score]).toEqual(['Claude Opus 4.5', 24.7]);
    expect([highest.model, highest.score]).toEqual(['Claude Opus 5', 48.7]);
    expect(text).toContain(`Claude went from 24.7% (Opus 4.5, ${monthYear(dayOf(lowest.released))})`);
    expect(text).toContain(`to 48.7% (Opus 5, ${monthYear(dayOf(highest.released))})`);
    // The chart's caption says the same, in the text's words.
    expect(text).toContain('from 24.7% to 48.7% in eight months');

    // The top score.
    expect(TOP_SCORE).toEqual({ model: 'Qwen 3.8 Max', released: '2026-07-19', score: 55.2 });
    expect(text).toContain('The top score on Sierra\'s leaderboard is 55.2% (Qwen 3.8 Max)');

    // The three fits reach the bar in the months the text names.
    expect(monthYear(TAU3_FITS.acrossLabs.crosses(TAU3_BAR))).toBe('April 2027');
    expect(monthYear(TAU3_FITS.opus.crosses(TAU3_BAR))).toBe('June 2027');
    expect(monthYear(TAU3_FITS.claude.crosses(TAU3_BAR))).toBe('October 2027');
    expect(text).toContain(
      'straight-line fits in log-odds reach 80% between April 2027 (the best score across labs) and October 2027 (all seven Claude models); the five Opus scores give June 2027',
    );

    // The source the text links.
    expect(TAU3_SOURCE).toEqual({ url: 'https://taubench.com/leaderboard/', read: '2026-10-29' });
    expect(text).toContain('(https://taubench.com/leaderboard)');
  });
});
