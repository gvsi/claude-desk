/**
 * The capability prediction's forecast in the words the page shows beside its text: the claim card's rows at a
 * glance and the chart's quarters. Each is built from `tau3.ts`, so it follows the rows and fits the text cites, and
 * `forecast.test.ts` holds it to the document. Whatever is predicted is named by its quarter; the fits' exact days
 * appear only in the document's own table.
 */
import { CLAUDE_SCORES, TAU3_BAR, TAU3_FITS, TAU3_SOURCE, TAU3_SOURCES, dayOf, quarterYear, type Tau3Row } from './tau3.ts';

/** A score as the boards print it: "56.0%". */
export function percent(score: number): string {
  return `${score.toFixed(1)}%`;
}

/** The latest Claude release scored on any board. */
export const LATEST_CLAUDE: Tau3Row = CLAUDE_SCORES[CLAUDE_SCORES.length - 1] as Tau3Row;

/** The day the boards were last read, which the chart marks as today. */
export const TODAY: Date = dayOf(
  Object.values(TAU3_SOURCES)
    .map((source) => source.read)
    .sort()
    .at(-1) as string,
);

/** The quarter the prediction names: the claim's "By Q4 2027". */
export const PREDICTION = { from: dayOf('2027-10-01'), to: dayOf('2028-01-01'), label: 'Q4 2027' } as const;

/** Where the trend reaches the bar: from where the Opus scores alone do to where all of Claude's scores do. */
export const BAND = { from: TAU3_FITS.opus.crosses(TAU3_BAR), to: TAU3_FITS.claude.crosses(TAU3_BAR) } as const;

/** Two days' quarters, the first without its year when they share one, and whether the second is early in its quarter. */
export interface QuarterSpan {
  from: string;
  to: string;
  /** The second day falls in its quarter's first month. */
  early: boolean;
}

export function quarterSpan(from: Date, to: Date): QuarterSpan {
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return {
    from: sameYear ? (quarterYear(from).split(' ')[0] ?? '') : quarterYear(from),
    to: quarterYear(to),
    early: to.getUTCMonth() % 3 === 0,
  };
}

/** The band's quarters, as its label says them: "Q2 to early Q4 2027". */
export function bandQuarters(): string {
  const { from, to, early } = quarterSpan(BAND.from, BAND.to);
  return `${from} to ${early ? 'early ' : ''}${to}`;
}

/** The bar as a percentage: "80%". */
const BAR = `${Math.round(TAU3_BAR * 100)}%`;

/** The first and the last day any of the text's three fits reaches the bar. */
const CROSSINGS = Object.values(TAU3_FITS)
  .map((fit) => fit.crosses(TAU3_BAR))
  .sort((a, b) => a.getTime() - b.getTime());

function trendWords(): string {
  const { from, to, early } = quarterSpan(CROSSINGS[0] as Date, CROSSINGS.at(-1) as Date);
  return `Straight-line fits reach ${BAR} between ${from} and ${early ? 'the start of ' : ''}${to}`;
}

/** One row of the prediction at a glance: its label, its value, and a link that ends the value. */
export interface GlanceRow {
  label: string;
  text: string;
  link?: { text: string; href: string };
}

/** The prediction at a glance, under the claim: the bar, where Claude is today, the trend and what would prove it wrong. */
export const GLANCE: readonly GlanceRow[] = [
  {
    label: 'The bar',
    text: `${BAR} of a bank’s customer-service tasks done right on the first try, on`,
    link: { text: 'τ³-Banking', href: TAU3_SOURCE.url },
  },
  { label: 'Today', text: `${LATEST_CLAUDE.model} at ${percent(LATEST_CLAUDE.score)} (${LATEST_CLAUDE.board})` },
  { label: 'The trend', text: trendWords() },
  // The document's first falsifier (forecast.test.ts holds it to the text).
  { label: 'Wrong if', text: 'No Claude model reaches 70% by the end of Q2 2027' },
];
