/**
 * The capability prediction's forecast in the words the page shows beside its text: the claim card's rows at a
 * glance and the chart's quarters. Each is built from `tau3.ts`, and each is held here to the words written out and
 * to the document, so the card, the chart and the text can't drift apart. Expected words are written out here, never
 * read from the module under test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BAND,
  GLANCE,
  LATEST_CLAUDE,
  PREDICTION,
  TODAY,
  bandQuarters,
  chartCaption,
  countWords,
  percent,
  quarterSpan,
} from './forecast.ts';
import { CLAUDE_SCORES, TOP_SCORE, dayOf, type Tau3Row } from './tau3.ts';

const PREDICTION_MD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/capability-prediction.md');

/** The prediction's Markdown, its straight quote marks curled as the page shows them, and its bold marks dropped. */
function documentWords(): string {
  return readFileSync(PREDICTION_MD, 'utf8').replaceAll('**', '').replaceAll("'", '’');
}

describe('the forecast at a glance', () => {
  it('glance_rows_say_the_prediction_in_four_lines', () => {
    expect(GLANCE.map((row) => [row.label, row.text, row.link ?? null])).toEqual([
      [
        'The bar',
        '80% of a bank’s customer-service tasks done right on the first try, on',
        { text: 'τ³-Banking', href: 'https://taubench.com/leaderboard/' },
      ],
      ['Today', 'Claude Opus 5.5 at 56.0% (Fireworks)', null],
      ['The trend', 'Straight-line fits reach 80% between Q2 and the start of Q4 2027', null],
      ['Wrong if', 'No Claude model reaches 70% by the end of Q2 2027', null],
    ]);
  });

  it('glance_rows_say_what_the_document_says', () => {
    const text = documentWords();
    // The bar, as the document sets it.
    expect(text).toContain('The bar is 80% pass^1.');
    // Today: the latest Claude score, and its board, as the document cites it.
    expect(LATEST_CLAUDE).toMatchObject({ model: 'Claude Opus 5.5', score: 56, board: 'Fireworks' });
    expect(text).toContain('to 56.0% (Opus 5.5, September 2026, Fireworks)');
    // The trend: the fits' first and last quarters, in the document's words.
    expect(text).toContain('straight-line fits in log-odds reach 80% between Q2 2027 and the start of Q4 2027');
    // Wrong if: the document's first falsifier, without naming the benchmark again.
    expect(text).toContain('no Claude model reaches 70% on τ³-Banking by the end of Q2 2027');
  });
});

describe('the forecast in quarters', () => {
  it('quarter_spans_name_the_quarters_and_an_early_end', () => {
    // Within a year, the year once; the end "early" in its quarter's first month; across a year, both years.
    expect(quarterSpan(dayOf('2027-05-31'), dayOf('2027-10-03'))).toEqual({ from: 'Q2', to: 'Q4 2027', early: true });
    expect(quarterSpan(dayOf('2027-05-31'), dayOf('2027-08-15'))).toEqual({ from: 'Q2', to: 'Q3 2027', early: false });
    expect(quarterSpan(dayOf('2027-05-31'), dayOf('2027-12-31'))).toEqual({ from: 'Q2', to: 'Q4 2027', early: false });
    expect(quarterSpan(dayOf('2026-11-02'), dayOf('2027-01-31'))).toEqual({ from: 'Q4 2026', to: 'Q1 2027', early: true });
  });

  it('band_runs_from_the_opus_fit_to_the_claude_fit', () => {
    // From where the six Opus scores reach 80% (May 31, 2027) to where all ten Claude scores do (Oct 3, 2027).
    expect(BAND.from.toISOString().slice(0, 10)).toBe('2027-05-31');
    expect(BAND.to.toISOString().slice(0, 10)).toBe('2027-10-03');
    expect(bandQuarters()).toBe('Q2 to early Q4 2027');
  });

  it('today_and_the_prediction_are_the_documents', () => {
    // Today is the day the boards were read; the prediction is the quarter the document names.
    expect(TODAY.toISOString().slice(0, 10)).toBe('2026-11-02');
    expect(documentWords()).toContain('Giovanni Alcantara · November 2, 2026');
    expect(PREDICTION).toEqual({ from: dayOf('2027-10-01'), to: dayOf('2028-01-01'), label: 'Q4 2027' });
    expect(documentWords()).toContain('By Q4 2027, a generally available Claude model will be able to act');
  });

  it('percent_prints_one_decimal', () => {
    expect([percent(56), percent(58.2), percent(37.3)]).toEqual(['56.0%', '58.2%', '37.3%']);
  });
});

describe('the chart caption', () => {
  const CAPTION =
    'Each dot is one model’s score. Seven of Claude’s scores, up to Opus 5, are from Sierra’s board; Sonnet 5 and ' +
    'Fable 5.1 are from Artificial Analysis (AA), and Opus 5.5 and Gemini 4 Argon from Fireworks. The line is a ' +
    'straight-line fit in log-odds through all ten Claude scores, dashed where it runs ahead of today. The band runs ' +
    'from where the Opus scores alone reach 80% to where all ten do. The boards’ setups differ, so scores from ' +
    'different boards are only roughly comparable.';

  it('caption_says_the_data', () => {
    expect(chartCaption(CLAUDE_SCORES, TOP_SCORE)).toBe(CAPTION);
  });

  it('caption_follows_the_data', () => {
    // Its counts and its boards are the rows': another Claude score on Fireworks joins that board's list, by release,
    // and the line runs through all eleven.
    const sonnet55: Tau3Row = { model: 'Claude Sonnet 5.5', released: '2026-11-20', score: 60, board: 'Fireworks' };
    expect(chartCaption([...CLAUDE_SCORES, sonnet55], TOP_SCORE)).toBe(
      CAPTION.replace('Opus 5.5 and Gemini 4 Argon from', 'Opus 5.5, Gemini 4 Argon and Sonnet 5.5 from').replaceAll(
        'all ten',
        'all eleven',
      ),
    );
    // Opus 5.5 scored on Sierra's own board instead: eight from Sierra, up to Opus 5.5, and Gemini alone on Fireworks.
    const onSierra = CLAUDE_SCORES.map((row) => (row.model === 'Claude Opus 5.5' ? { ...row, board: 'Sierra' as const } : row));
    expect(chartCaption(onSierra, TOP_SCORE)).toBe(
      CAPTION.replace('Seven of Claude’s scores, up to Opus 5,', 'Eight of Claude’s scores, up to Opus 5.5,').replace(
        'Opus 5.5 and Gemini 4 Argon from Fireworks',
        'Gemini 4 Argon from Fireworks',
      ),
    );
    // A board's first group says "is" for one score.
    const oneOnAA = CLAUDE_SCORES.filter((row) => row.model !== 'Claude Sonnet 5');
    expect(chartCaption(oneOnAA, TOP_SCORE)).toContain('board; Fable 5.1 is from Artificial Analysis (AA), and Opus 5.5');
    expect(chartCaption(oneOnAA, TOP_SCORE)).toContain('through all nine Claude scores');
  });

  it('count_words_spell_small_counts', () => {
    expect([1, 7, 10, 11, 20, 21].map(countWords)).toEqual(['one', 'seven', 'ten', 'eleven', 'twenty', '21']);
  });
});
