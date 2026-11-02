/**
 * τ³-Banking scores as three boards list them (Sierra's own leaderboard, Fireworks' index and Artificial Analysis),
 * and the straight-line fits the capability prediction cites. The prediction's chart draws only these rows and these
 * fits; `tau3.test.ts` holds each claim to the text.
 */
import { MONTHS } from './months.ts';

/** The boards a score can come from. Their setups differ, so every score names its board. */
export type Tau3Board = 'Sierra' | 'Fireworks' | 'AA';

/** Each board's page, and the day its rows were read. */
export const TAU3_SOURCES: Readonly<Record<Tau3Board, { name: string; url: string; read: string }>> = {
  Sierra: { name: 'Sierra', url: 'https://taubench.com/leaderboard/', read: '2026-11-02' },
  Fireworks: {
    name: 'Fireworks',
    url: 'https://fireworks.ai/specialized-intelligence-index/benchmarks/customer-support/tau3-banking',
    read: '2026-11-02',
  },
  AA: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/evaluations/tau3-banking', read: '2026-11-02' },
};

/** Sierra's own leaderboard, the benchmark's home. */
export const TAU3_SOURCE = { url: TAU3_SOURCES.Sierra.url, read: TAU3_SOURCES.Sierra.read } as const;

export interface Tau3Row {
  /** The model's name as its board lists it. */
  model: string;
  /** Its release date, `YYYY-MM-DD`. */
  released: string;
  /** Its score, in percent: pass^1 on Sierra's board, the mean over trials on the others. */
  score: number;
  /** The board the score comes from. */
  board: Tau3Board;
}

/** Every pass^1 row on Sierra's leaderboard, in its order. */
export const LEADERBOARD: readonly Tau3Row[] = ([
  { model: 'Qwen 3.8 Max', released: '2026-07-19', score: 55.2 },
  { model: 'Claude Opus 5', released: '2026-07-24', score: 48.7 },
  { model: 'Grok 4.5', released: '2026-07-16', score: 47.9 },
  { model: 'GPT-5.6-sol', released: '2026-07-09', score: 46.9 },
  { model: 'GPT-5.5', released: '2026-04-23', score: 44.6 },
  { model: 'Muse Spark 1.1', released: '2026-07-09', score: 40.5 },
  { model: 'Claude Opus 4.7', released: '2026-04-16', score: 40.2 },
  { model: 'Claude Opus 4.8', released: '2026-05-28', score: 39.7 },
  { model: 'Claude Fable 5', released: '2026-06-09', score: 39.7 },
  { model: 'GPT-5.4', released: '2026-03-05', score: 39.4 },
  { model: 'Kimi K3', released: '2026-07-16', score: 37.1 },
  { model: 'GLM-5.2', released: '2026-06-16', score: 37.1 },
  { model: 'GPT-5.2', released: '2025-12-11', score: 32.2 },
  { model: 'Gemini 3 Flash', released: '2025-12-17', score: 27.3 },
  { model: 'Claude Opus 4.6', released: '2026-02-05', score: 27.3 },
  { model: 'Gemini 3.1 Pro Preview', released: '2026-02-19', score: 26.0 },
  { model: 'Claude Sonnet 4.5', released: '2025-09-29', score: 25.3 },
  { model: 'Inkling', released: '2026-07-15', score: 25.0 },
  { model: 'Claude Opus 4.5', released: '2025-11-24', score: 24.7 },
  { model: 'Gemini 3 Pro', released: '2025-11-18', score: 18.0 },
  { model: 'Grok 4.2', released: '2026-03-10', score: 18.0 },
  { model: 'Grok 4 fast', released: '2025-09-19', score: 15.7 },
  { model: 'Gemini 2.5 Pro', released: '2025-06-17', score: 13.7 },
  { model: 'Grok 4.1 fast', released: '2025-11-19', score: 13.1 },
  // The leaderboard lists GPT-5.2 twice, in two configurations, under the same name.
  { model: 'GPT-5.2', released: '2025-12-11', score: 12.6 },
  { model: 'GLM-5', released: '2026-02-11', score: 9.8 },
  { model: 'Qwen3.5-397B-A17B', released: '2026-02-16', score: 9.8 },
] as const).map((row) => ({ ...row, board: 'Sierra' as const }));

/**
 * Every Claude score on the other two boards that Sierra doesn't list, Gemini 4 Argon, and the scores the text cites
 * to show how far the boards can differ. A release date is Sierra's where it lists the model, otherwise the lab's own.
 * Artificial Analysis lists a model once per setting, such as "Claude Sonnet 5 (Max)"; the name here drops the setting.
 */
export const OTHER_BOARDS: readonly Tau3Row[] = [
  { model: 'Gemini 4 Argon', released: '2026-10-13', score: 58.2, board: 'Fireworks' },
  { model: 'Claude Opus 5.5', released: '2026-09-22', score: 56.0, board: 'Fireworks' },
  { model: 'Kimi K3', released: '2026-07-16', score: 51.5, board: 'Fireworks' },
  { model: 'Claude Opus 5', released: '2026-07-24', score: 49.1, board: 'Fireworks' },
  { model: 'Claude Fable 5.1', released: '2026-09-01', score: 47.2, board: 'AA' },
  { model: 'Claude Opus 5', released: '2026-07-24', score: 44.7, board: 'AA' },
  { model: 'Claude Sonnet 5', released: '2026-06-30', score: 37.3, board: 'AA' },
];

/** One score per model for the fits: Sierra's where it lists the model, otherwise the other board's. */
const FIT_ROWS: readonly Tau3Row[] = [
  ...LEADERBOARD,
  ...OTHER_BOARDS.filter((row) => !LEADERBOARD.some((listed) => listed.model === row.model)),
];

const DAY = 24 * 60 * 60 * 1000;

/** A `YYYY-MM-DD` day as the UTC midnight it starts at. */
export function dayOf(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Days from the Unix epoch to the start of `iso`. */
function daysOf(iso: string): number {
  return dayOf(iso).getTime() / DAY;
}

/** Rows by release date, the higher score first on a shared day. */
function byRelease(rows: readonly Tau3Row[]): Tau3Row[] {
  return [...rows].sort((a, b) => a.released.localeCompare(b.released) || b.score - a.score);
}

/** Each release that set a new top score: higher than every release before it. */
export function bestSoFar(rows: readonly Tau3Row[]): Tau3Row[] {
  let top = -Infinity;
  return byRelease(rows).filter((row) => {
    if (row.score <= top) return false;
    top = row.score;
    return true;
  });
}

export interface LogOddsFit {
  /** The fit's score, as a share from 0 to 1, on `date`. */
  at(date: Date): number;
  /** The day the fit reaches `share` (0.8 for the 80% bar). */
  crosses(share: number): Date;
}

/**
 * An ordinary least-squares line through the scores in log-odds, ln(p / (1 − p)), against the release date in
 * days: a straight line there is an S-curve in percent. It reaches 80% where the line reaches ln 4.
 */
export function logOddsFit(points: readonly Tau3Row[]): LogOddsFit {
  if (points.length < 2) throw new Error('a fit needs at least two scores');
  const xs = points.map((point) => daysOf(point.released));
  const ys = points.map((point) => Math.log(point.score / (100 - point.score)));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const sxy = xs.reduce((sum, x, i) => sum + (x - mx) * ((ys[i] ?? 0) - my), 0);
  if (sxx === 0) throw new Error('a fit needs scores on more than one day');
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return {
    at: (date) => 1 / (1 + Math.exp(-(intercept + (slope * date.getTime()) / DAY))),
    crosses: (share) => new Date(((Math.log(share / (1 - share)) - intercept) / slope) * DAY),
  };
}

/** The bar the prediction sets: 80% pass^1. */
export const TAU3_BAR = 0.8;

/** The ten Claude releases scored on any board, one score each, by release date. */
export const CLAUDE_SCORES: readonly Tau3Row[] = byRelease(FIT_ROWS.filter((row) => row.model.startsWith('Claude ')));

/** The highest score on any board, from any lab. */
export const TOP_SCORE: Tau3Row = FIT_ROWS.reduce((top, row) => (row.score > top.score ? row : top));

/** The three fits the text cites: the best score across labs, the six Opus scores and all ten Claude scores. */
export const TAU3_FITS = {
  acrossLabs: logOddsFit(bestSoFar(FIT_ROWS)),
  opus: logOddsFit(CLAUDE_SCORES.filter((row) => row.model.startsWith('Claude Opus '))),
  claude: logOddsFit(CLAUDE_SCORES),
} as const;

/** "April 2027": a day's month as the text names it, in UTC. */
export function monthYear(date: Date): string {
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/** "Q3 2027": a day's quarter, as the text names the prediction and the fits, in UTC. */
export function quarterYear(date: Date): string {
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
}

/** "Apr 2027": the month shortened to three letters, for the chart's axis and labels. */
export function shortMonthYear(date: Date): string {
  return `${(MONTHS[date.getUTCMonth()] ?? '').slice(0, 3)} ${date.getUTCFullYear()}`;
}

/** "Jul 24, 2026": a release date, for the chart's point titles and its table. */
export function shortDate(iso: string): string {
  const date = dayOf(iso);
  return `${(MONTHS[date.getUTCMonth()] ?? '').slice(0, 3)} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
