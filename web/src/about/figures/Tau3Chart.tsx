/**
 * Claude's τ³-Banking scores, the capability prediction's lead figure: the seven Claude releases in primary
 * ink with the latest ringed, the top score from any lab as a hollow point, the 80% bar, the prediction date,
 * the straight-line fit through all seven from the latest release on, and the band between the fits the text
 * cites. Everything it draws comes from `tau3.ts`, whose tests hold it to the prediction's text.
 */
import { useId } from 'react';

import { TextLink } from '../../ds/index.ts';
import {
  CLAUDE_SCORES,
  TAU3_BAR,
  TAU3_FITS,
  TAU3_SOURCE,
  TOP_SCORE,
  dayOf,
  monthYear,
  shortDate,
  shortMonthYear,
  type Tau3Row,
} from '../tau3.ts';

import '../reader.css';

export interface Tau3ChartProps {
  /** The phone layout: a narrower plot that keeps only the short labels. */
  compact?: boolean;
}

/** The end of the month the prediction names ("By October 2027"). */
const PREDICTION_DATE = dayOf('2027-10-31');

/** The plot's time span, from the first Claude release's month to past the prediction date. */
const DOMAIN = { from: dayOf('2025-09-01'), to: dayOf('2028-01-01') };

/** Each layout's drawing, in its viewBox's units. */
interface Layout {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  point: number;
  ring: number;
  /** Ticks on the time axis, with their labels. */
  ticks: { iso: string; label: string }[];
  /** The score axis's label at each gridline. */
  scoreLabel: (score: number) => string;
  dash: string;
}

const DESKTOP: Layout = {
  width: 1000,
  height: 440,
  plot: { left: 56, right: 972, top: 28, bottom: 392 },
  point: 6,
  ring: 11,
  ticks: ['2026-01-01', '2026-07-01', '2027-01-01', '2027-07-01'].map((iso) => ({ iso, label: shortMonthYear(dayOf(iso)) })),
  scoreLabel: (score) => `${score}%`,
  dash: '6 6',
};

const PHONE: Layout = {
  width: 350,
  height: 300,
  plot: { left: 36, right: 340, top: 22, bottom: 266 },
  point: 5,
  ring: 9,
  ticks: ['2026-01-01', '2027-01-01'].map((iso) => ({ iso, label: iso.slice(0, 4) })),
  scoreLabel: (score) => `${score}`,
  dash: '5 5',
};

const GRID = [0, 20, 40, 60, 80, 100];
/** Ten days between the fit line's samples. */
const FIT_STEP = 10 * 24 * 60 * 60 * 1000;

/** A score as the leaderboard prints it: "48.7%". */
function percent(score: number): string {
  return `${score.toFixed(1)}%`;
}

/** A model's name without "Claude ", for a label beside its point. */
function shortName(row: Tau3Row): string {
  return row.model.replace(/^Claude /, '');
}

/** "Apr to Oct 2027", or "Nov 2026 to Feb 2027" across a year. */
function monthRange(from: Date, to: Date): string {
  const [fromMonth, fromYear] = shortMonthYear(from).split(' ');
  const end = shortMonthYear(to);
  return fromYear === end.split(' ')[1] ? `${fromMonth} to ${end}` : `${shortMonthYear(from)} to ${end}`;
}

/** Two decimals are finer than a pixel at either size, and keep the markup short. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const LOWEST = CLAUDE_SCORES.reduce((low, row) => (row.score < low.score ? row : low));
const LATEST = CLAUDE_SCORES[CLAUDE_SCORES.length - 1] ?? LOWEST;
const BAND = { from: TAU3_FITS.acrossLabs.crosses(TAU3_BAR), to: TAU3_FITS.claude.crosses(TAU3_BAR) };

/** Every point the chart draws, by release date, for its text equivalent. */
const POINTS = [...CLAUDE_SCORES, TOP_SCORE].sort((a, b) => a.released.localeCompare(b.released));

/** What the dashed line and the band show, in the months the text names. */
const FIT_SENTENCE =
  `The dashed line, a straight-line fit in log-odds through all seven Claude scores, reaches 80% in ` +
  `${monthYear(BAND.to)}; the band runs from ${monthYear(BAND.from)}, where the fit through the best score ` +
  `across labs reaches 80%, to ${monthYear(BAND.to)}.`;

export function Tau3Chart({ compact = false }: Tau3ChartProps) {
  const id = useId();
  const captionId = `${id}-caption`;
  const tableId = `${id}-table`;
  const layout = compact ? PHONE : DESKTOP;
  const { plot } = layout;
  const span = DOMAIN.to.getTime() - DOMAIN.from.getTime();
  const x = (date: Date) => round(plot.left + ((date.getTime() - DOMAIN.from.getTime()) / span) * (plot.right - plot.left));
  const y = (score: number) => round(plot.bottom - (score / 100) * (plot.bottom - plot.top));
  const at = (row: Tau3Row) => ({ cx: x(dayOf(row.released)), cy: y(row.score) });

  const fit: string[] = [];
  for (let t = dayOf(LATEST.released).getTime(); t < PREDICTION_DATE.getTime(); t += FIT_STEP) {
    fit.push(`${x(new Date(t))},${y(TAU3_FITS.claude.at(new Date(t)) * 100)}`);
  }
  fit.push(`${x(PREDICTION_DATE)},${y(TAU3_FITS.claude.at(PREDICTION_DATE) * 100)}`);

  const bar = y(TAU3_BAR * 100);
  const band = { left: x(BAND.from), right: x(BAND.to) };
  const prediction = x(PREDICTION_DATE);
  const top = at(TOP_SCORE);
  const lowest = at(LOWEST);
  const latest = at(LATEST);

  return (
    <figure className={`cd-about-figure cd-about-chart${compact ? ' cd-about-figure--compact cd-about-chart--compact' : ''}`}>
      <div className="cd-about-frame cd-about-chart__frame">
        <div className="cd-about-chart__head">
          <p className="cd-about-figure-title cd-type-section">Claude on τ³-Banking, pass^1</p>
          <p className="cd-about-chart__key cd-type-caption">
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-dot" aria-hidden="true" />
              Claude releases
            </span>
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-dash" aria-hidden="true" />
              {compact ? (
                'Fit, all seven'
              ) : (
                <>
                  <code className="cd-about-code">estimate:</code> log-odds fit, all seven
                </>
              )}
            </span>
          </p>
        </div>
        <svg
          className="cd-about-chart__plot"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-labelledby={captionId}
          aria-describedby={tableId}
        >
          <rect
            data-band=""
            className="cd-about-chart__band"
            x={band.left}
            y={plot.top}
            width={round(band.right - band.left)}
            height={plot.bottom - plot.top}
          />
          {GRID.filter((score) => score !== TAU3_BAR * 100).map((score) => (
            <line key={score} className="cd-about-chart__grid" x1={plot.left} x2={plot.right} y1={y(score)} y2={y(score)} />
          ))}
          {layout.ticks.map(({ iso }) => (
            <line
              key={iso}
              className="cd-about-chart__axis-line"
              x1={x(dayOf(iso))}
              x2={x(dayOf(iso))}
              y1={plot.bottom}
              y2={plot.bottom + (compact ? 5 : 6)}
            />
          ))}
          <line className="cd-about-chart__axis-line" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />

          <line data-bar="" className="cd-about-chart__bar" x1={plot.left} x2={plot.right} y1={bar} y2={bar} />
          <text className="cd-about-chart__label cd-type-caption" x={plot.left + (compact ? 4 : 8)} y={bar - (compact ? 8 : 10)}>
            {compact ? '80% bar' : 'The bar: 80% pass^1'}
          </text>
          <line className="cd-about-chart__rule" x1={prediction} x2={prediction} y1={plot.top} y2={plot.bottom} />
          <text
            className="cd-about-chart__label cd-type-caption"
            x={prediction - (compact ? 6 : 8)}
            y={plot.top + (compact ? 12 : 14)}
            textAnchor="end"
          >
            {compact ? shortMonthYear(PREDICTION_DATE) : `Prediction date, ${shortMonthYear(PREDICTION_DATE)}`}
          </text>
          {compact ? (
            <text className="cd-about-chart__axis cd-type-caption" x={(band.left + band.right) / 2} y={plot.bottom - 10} textAnchor="middle">
              Fits
            </text>
          ) : (
            <>
              <text className="cd-about-chart__axis cd-type-caption" x={(band.left + band.right) / 2} y={plot.bottom - 30} textAnchor="middle">
                Fits cross the bar
              </text>
              <text className="cd-about-chart__axis cd-type-caption" x={(band.left + band.right) / 2} y={plot.bottom - 14} textAnchor="middle">
                {monthRange(BAND.from, BAND.to)}
              </text>
            </>
          )}

          <polyline data-fit="" className="cd-about-chart__fit" points={fit.join(' ')} strokeDasharray={layout.dash} />

          <circle data-point="top" className="cd-about-chart__top" {...top} r={layout.point}>
            <title>{`${TOP_SCORE.model}, ${shortDate(TOP_SCORE.released)}: ${percent(TOP_SCORE.score)}, the top score`}</title>
          </circle>
          {compact ? null : (
            <text
              data-point-label=""
              className="cd-about-chart__label cd-type-caption"
              x={top.cx - 12}
              y={top.cy - 12}
              textAnchor="end"
            >
              {`Top score, ${TOP_SCORE.model} ${percent(TOP_SCORE.score)}`}
            </text>
          )}
          {CLAUDE_SCORES.map((row) => (
            <circle key={row.model} data-point="claude" className="cd-about-chart__point" {...at(row)} r={layout.point}>
              <title>{`${row.model}, ${shortDate(row.released)}: ${percent(row.score)}`}</title>
            </circle>
          ))}
          <text
            data-point-label=""
            className="cd-about-chart__label cd-type-caption"
            x={lowest.cx}
            y={lowest.cy + (compact ? 20 : 26)}
            textAnchor="middle"
          >
            {compact ? percent(LOWEST.score) : `${shortName(LOWEST)} ${percent(LOWEST.score)}`}
          </text>
          <circle data-ring="" className="cd-about-chart__ring" cx={latest.cx} cy={latest.cy} r={layout.ring} />
          <text
            data-point-label=""
            className="cd-about-chart__label cd-type-caption"
            x={latest.cx + (compact ? 12 : 16)}
            y={latest.cy + (compact ? 20 : 24)}
          >
            {`${shortName(LATEST)} ${percent(LATEST.score)}`}
          </text>

          {GRID.map((score) => (
            <text
              key={score}
              className="cd-about-chart__axis cd-type-caption"
              x={plot.left - (compact ? 8 : 12)}
              y={y(score) + 4}
              textAnchor="end"
            >
              {layout.scoreLabel(score)}
            </text>
          ))}
          {layout.ticks.map(({ iso, label }) => (
            <text
              key={iso}
              className="cd-about-chart__axis cd-type-caption"
              x={x(dayOf(iso))}
              y={plot.bottom + (compact ? 20 : 24)}
              textAnchor="middle"
            >
              {label}
            </text>
          ))}
        </svg>
        <div id={tableId} className="cd-sr-only">
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Released</th>
                <th scope="col">pass^1</th>
              </tr>
            </thead>
            <tbody>
              {POINTS.map((row) => (
                <tr key={row.model}>
                  <th scope="row">{row === TOP_SCORE ? `${row.model}, the top score` : row.model}</th>
                  <td>{shortDate(row.released)}</td>
                  <td>{percent(row.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{FIT_SENTENCE}</p>
        </div>
      </div>
      <figcaption id={captionId} className={`cd-about-figcaption ${compact ? 'cd-type-caption' : 'cd-type-article-caption'}`}>
        <span className="cd-about-fignum">Figure 1</span>{' '}
        <span>
          {`Seven Claude releases on Sierra’s τ³-Banking leaderboard; ${shortName(LOWEST)} to ${shortName(LATEST)} `}
          {`rose from ${percent(LOWEST.score)} to ${percent(LATEST.score)} in eight months. `}
          The dashed line is a straight-line fit in log-odds through all seven;{' '}
          {compact ? 'the band' : 'the shaded band'} is where the fits in the text cross 80%. Source:{' '}
          <TextLink href={TAU3_SOURCE.url} external>
            taubench.com
          </TextLink>
          {compact ? '.' : ', pass^1 as listed.'}
        </span>
      </figcaption>
    </figure>
  );
}
