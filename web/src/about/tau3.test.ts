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
  OTHER_BOARDS,
  TAU3_BAR,
  TAU3_FITS,
  TAU3_SOURCE,
  TAU3_SOURCES,
  TOP_SCORE,
  bestSoFar,
  dayOf,
  logOddsFit,
  monthYear,
  quarterYear,
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

  it('other_boards_name_their_board', () => {
    // Sierra's rows are all Sierra's; the newer scores name the board that lists them.
    expect(LEADERBOARD.every((row) => row.board === 'Sierra')).toBe(true);
    expect(OTHER_BOARDS.map((row) => `${row.model} ${row.score} ${row.board}`)).toEqual([
      'Gemini 4 Argon 58.2 Fireworks',
      'Claude Opus 5.5 56 Fireworks',
      'Kimi K3 51.5 Fireworks',
      'Claude Opus 5 49.1 Fireworks',
      'Claude Fable 5.1 47.2 AA',
    ]);
    expect(Object.keys(TAU3_SOURCES)).toEqual(['Sierra', 'Fireworks', 'AA']);
  });

  it('fits_cross_the_bar_when_the_text_says', () => {
    // A model Sierra lists keeps Sierra's score: Opus 5 is fitted at 48.7, not Fireworks' 49.1.
    const claude = LEADERBOARD.filter((row) => row.model.startsWith('Claude '));
    const newer = OTHER_BOARDS.filter((row) => ['Claude Opus 5.5', 'Claude Fable 5.1'].includes(row.model));
    const opus = [...claude, ...newer].filter((row) => row.model.startsWith('Claude Opus '));
    expect(claude).toHaveLength(7);
    expect(opus.map((row) => row.model)).toEqual([
      'Claude Opus 5',
      'Claude Opus 4.7',
      'Claude Opus 4.8',
      'Claude Opus 4.6',
      'Claude Opus 4.5',
      'Claude Opus 5.5',
    ]);
    // Each release that set a new top score on Sierra's board, in release order.
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

    // Then Opus 5.5 and Gemini 4 Argon, on Fireworks, each set a new top.
    const argon = OTHER_BOARDS.filter((row) => row.model === 'Gemini 4 Argon');
    const acrossLabs = bestSoFar([...LEADERBOARD, ...newer, ...argon]);
    expect(acrossLabs.slice(-3).map((row) => `${row.model} ${row.score}`)).toEqual([
      'Qwen 3.8 Max 55.2',
      'Claude Opus 5.5 56',
      'Gemini 4 Argon 58.2',
    ]);

    // The table's exact days: Opus May 31, 2027; best across labs May 16, 2027; all nine Claude September 7, 2027.
    expect(daysFrom(logOddsFit(acrossLabs).crosses(0.8), '2027-05-16')).toBeLessThan(1);
    expect(daysFrom(logOddsFit(opus).crosses(0.8), '2027-05-31')).toBeLessThan(1);
    expect(daysFrom(logOddsFit([...claude, ...newer]).crosses(0.8), '2027-09-07')).toBeLessThan(1);
    // The exported fits are the same three.
    expect(daysFrom(TAU3_FITS.acrossLabs.crosses(0.8), '2027-05-16')).toBeLessThan(1);
    expect(daysFrom(TAU3_FITS.opus.crosses(0.8), '2027-05-31')).toBeLessThan(1);
    expect(daysFrom(TAU3_FITS.claude.crosses(0.8), '2027-09-07')).toBeLessThan(1);
  });

  it('chart_claims_are_the_predictions', () => {
    const text = readFileSync(PREDICTION, 'utf8');
    for (const claim of ['24.7%', '48.7%', '55.2%', '56.0%', '58.2%', '47.2%', 'Q2–Q3 2027', 'Q4 2027']) {
      expect(text, claim).toContain(claim);
    }

    // The bar.
    expect(text).toContain('The bar is 80% pass^1');
    expect(TAU3_BAR).toBe(0.8);

    // The nine Claude scores, by release, each from its board, run from 24.7 (Opus 4.5) to 56.0 (Opus 5.5).
    expect(CLAUDE_SCORES.map((row) => `${row.model} ${row.released} ${row.score} ${row.board}`)).toEqual([
      'Claude Sonnet 4.5 2025-09-29 25.3 Sierra',
      'Claude Opus 4.5 2025-11-24 24.7 Sierra',
      'Claude Opus 4.6 2026-02-05 27.3 Sierra',
      'Claude Opus 4.7 2026-04-16 40.2 Sierra',
      'Claude Opus 4.8 2026-05-28 39.7 Sierra',
      'Claude Fable 5 2026-06-09 39.7 Sierra',
      'Claude Opus 5 2026-07-24 48.7 Sierra',
      'Claude Fable 5.1 2026-09-01 47.2 AA',
      'Claude Opus 5.5 2026-09-22 56 Fireworks',
    ]);
    const lowest = CLAUDE_SCORES.reduce((a, b) => (b.score < a.score ? b : a));
    const highest = CLAUDE_SCORES.reduce((a, b) => (b.score > a.score ? b : a));
    expect([lowest.model, lowest.score, lowest.board]).toEqual(['Claude Opus 4.5', 24.7, 'Sierra']);
    expect([highest.model, highest.score, highest.board]).toEqual(['Claude Opus 5.5', 56, 'Fireworks']);
    expect(text).toContain(
      `Claude went from 24.7% (Opus 4.5, ${monthYear(dayOf(lowest.released))}, Sierra) to 56.0% (Opus 5.5, ${monthYear(dayOf(highest.released))}, Fireworks) in ten months`,
    );
    expect(text).toContain('rose from 24.7% (Sierra) to 56.0% (Fireworks) in ten months');

    // The top score on any board, and Sierra's own.
    expect(TOP_SCORE).toEqual({ model: 'Gemini 4 Argon', released: '2026-10-13', score: 58.2, board: 'Fireworks' });
    expect(text).toContain('It puts Gemini 4 Argon on top at 58.2% and Claude Opus 5.5 second at 56.0%');
    const sierraTop = LEADERBOARD.reduce((top, row) => (row.score > top.score ? row : top));
    expect([sierraTop.model, sierraTop.score]).toEqual(['Qwen 3.8 Max', 55.2]);
    expect(text).toContain('The top score on Sierra\'s leaderboard is 55.2% (Qwen 3.8 Max)');

    // The three fits reach the bar in the quarters the text names.
    expect(quarterYear(TAU3_FITS.acrossLabs.crosses(TAU3_BAR))).toBe('Q2 2027');
    expect(quarterYear(TAU3_FITS.opus.crosses(TAU3_BAR))).toBe('Q2 2027');
    expect(quarterYear(TAU3_FITS.claude.crosses(TAU3_BAR))).toBe('Q3 2027');
    expect(text).toContain(
      'straight-line fits in log-odds reach 80% in Q2–Q3 2027: the six Opus scores and the best score across labs in Q2 2027, and all nine Claude scores in Q3 2027',
    );
    expect(text).toContain('| Opus | Sierra\'s five, and Opus 5.5 on Fireworks | May 31, 2027 |');
    expect(text).toContain('| Best across labs | Each new top score on Sierra\'s board, then Opus 5.5 and Gemini 4 Argon on Fireworks | May 16, 2027 |');
    expect(text).toContain('| All Claude | Sierra\'s seven, Opus 5.5 on Fireworks and Fable 5.1 on Artificial Analysis | September 7, 2027 |');

    // The sources the text links.
    expect(TAU3_SOURCE).toEqual({ url: 'https://taubench.com/leaderboard/', read: '2026-11-02' });
    expect(text).toContain('(https://taubench.com/leaderboard)');
    expect(text).toContain(`(${TAU3_SOURCES.Fireworks.url})`);
    expect(text).toContain(`(${TAU3_SOURCES.AA.url})`);
  });
});
