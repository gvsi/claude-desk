/**
 * The capability prediction's forecast in the words the page shows beside its text: the claim card's rows at a
 * glance and the chart's quarters. Each is built from `tau3.ts`, so it follows the rows and fits the text cites, and
 * `forecast.test.ts` holds it to the document. Whatever is predicted is named by its quarter; the fits' exact days
 * appear only in the document's own table.
 */
import {
  CLAUDE_SCORES,
  TAU3_BAR,
  TAU3_FITS,
  TAU3_SOURCE,
  TAU3_SOURCES,
  dayOf,
  quarterYear,
  type Tau3Board,
  type Tau3Row,
} from './tau3.ts';

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
export const BAR = `${Math.round(TAU3_BAR * 100)}%`;

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];

/** A count in words, as the chart's words say it: "ten"; past twenty, in digits. */
export function countWords(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** "A", "A and B", "A, B and C". */
function listed(words: string[]): string {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/** A model's name without "Claude ", as the chart's labels and caption say it. */
export function shortName(row: Tau3Row): string {
  return row.model.replace(/^Claude /, '');
}

/** A board as the chart's caption names it: its name, with the short name its labels use when that differs. */
function boardName(board: Tau3Board): string {
  const { name } = TAU3_SOURCES[board];
  return name === board ? name : `${name} (${board})`;
}

/**
 * The chart's caption, from the rows it draws: how many of Claude's scores come from Sierra's board, which scores come
 * from each other board (the boards in the order of their first score), how many scores the line runs through, and
 * the bar.
 */
export function chartCaption(claude: readonly Tau3Row[], top: Tau3Row): string {
  const byRelease = (a: Tau3Row, b: Tau3Row) => a.released.localeCompare(b.released);
  const sierra = claude.filter((row) => row.board === 'Sierra').sort(byRelease);
  const groups = new Map<Tau3Board, Tau3Row[]>();
  for (const row of [...claude.filter((score) => score.board !== 'Sierra'), top].sort(byRelease)) {
    groups.set(row.board, [...(groups.get(row.board) ?? []), row]);
  }
  const fromBoards = [...groups].map(([board, rows], i) => {
    const verb = i > 0 ? '' : rows.length === 1 ? ' is' : ' are';
    return `${listed(rows.map(shortName))}${verb} from ${boardName(board)}`;
  });
  const others = fromBoards.length < 2 ? (fromBoards[0] ?? '') : `${fromBoards.slice(0, -1).join(', ')}, and ${fromBoards.at(-1) ?? ''}`;
  const count = countWords(sierra.length);
  const last = sierra.at(-1);
  const fromSierra = last
    ? `${count.charAt(0).toUpperCase()}${count.slice(1)} of Claude’s scores, up to ${shortName(last)}, are from ${TAU3_SOURCES.Sierra.name}’s board; `
    : '';
  const all = countWords(claude.length);
  return (
    `Each dot is one model’s score. ${fromSierra}${others}. The line is a straight-line fit in log-odds through all ` +
    `${all} Claude scores, dashed where it runs ahead of today. The band runs from where the Opus scores alone reach ` +
    `${BAR} to where all ${all} do. The boards’ setups differ, so scores from different boards are only roughly ` +
    `comparable.`
  );
}

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

/**
 * The prediction at a glance, under the claim: the bar, where Claude is today, the trend, the safety prediction and
 * what would prove the two predictions wrong. Safety and Wrong if restate the document's "Prediction:" and
 * "Falsifier:" lines (forecast.test.ts holds them to the text).
 */
export const GLANCE: readonly GlanceRow[] = [
  {
    label: 'The bar',
    text: `${BAR} of a bank’s customer-service tasks done right on the first try, on`,
    link: { text: 'τ³-Banking', href: TAU3_SOURCE.url },
  },
  { label: 'Today', text: `${LATEST_CLAUDE.model} at ${percent(LATEST_CLAUDE.score)} (${LATEST_CLAUDE.board})` },
  { label: 'The trend', text: trendWords() },
  {
    label: 'Safety',
    text: 'Prompt injection keeps falling; manipulation by the person in the chat won’t be shown solved through Q4 2027',
  },
  {
    label: 'Wrong if',
    text:
      'No Claude model reaches 70% by the end of Q2 2027, or a public red team playing the person in the chat can’t ' +
      'get a model with no limits in code to break an owner’s rule',
  },
];
