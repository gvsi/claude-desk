/**
 * Claude's τ³-Banking scores and when their trend reaches the prediction's bar, as the prediction board draws it:
 * every Claude release scored on any board in primary ink with the latest ringed, the top score from any lab as a
 * hollow point, each labelled score naming its board; the 80% bar; today; the straight-line fit through all of them,
 * solid through the scores and dashed ahead of today to the bar; the band from where the Opus fit reaches the bar to
 * where the fit through all of them does; and the prediction's quarter. Time is in quarters throughout. Everything it
 * draws comes from `tau3.ts` (through `forecast.ts`), whose tests hold it to the prediction's text.
 */
import { useId, type CSSProperties } from 'react';

import {
  BAND,
  BAR,
  LATEST_CLAUDE,
  PREDICTION,
  TODAY,
  bandQuarters,
  chartCaption,
  countWords,
  percent,
  quarterSpan,
  shortName,
} from '../forecast.ts';
import {
  CLAUDE_SCORES,
  TAU3_BAR,
  TAU3_FITS,
  TAU3_SOURCES,
  TOP_SCORE,
  dayOf,
  monthYear,
  quarterYear,
  type Tau3Row,
} from '../tau3.ts';
import { usePlayOnce } from './usePlayOnce.ts';

import '../reader.css';

/** A Claude release's point, with its place in date order, from which its turn to appear is worked out. */
type PointStyle = CSSProperties & { '--cd-tau3-i': number };

/** The chart, with the number of releases, which sets when the parts after them come in. */
type ChartStyle = CSSProperties & { '--cd-tau3-count': number };

export interface Tau3ChartProps {
  /** The phone layout: a narrower plot, a shorter subtitle and key, and fewer labels. */
  compact?: boolean;
}

/** The plot's time span: Q3 2025, the first Claude score's quarter, to the end of the prediction's quarter. */
const DOMAIN = { from: dayOf('2025-07-01'), to: PREDICTION.to };

/** Each quarter's first day across the plot, its last quarter's end included. */
const QUARTERS: Date[] = [];
for (let at = DOMAIN.from; at.getTime() <= DOMAIN.to.getTime(); at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 3, 1))) {
  QUARTERS.push(at);
}

/** Each year on the plot, with the span of it the plot shows, for its name under its quarters. */
const YEARS = [...new Set(QUARTERS.slice(0, -1).map((day) => day.getUTCFullYear()))].map((year) => ({
  year,
  from: new Date(Math.max(Date.UTC(year, 0, 1), DOMAIN.from.getTime())),
  to: new Date(Math.min(Date.UTC(year + 1, 0, 1), DOMAIN.to.getTime())),
}));

/** Where a label sits, from its point: its offset in the plot's units and the side its words run to. */
interface LabelPlace {
  dx: number;
  dy: number;
  anchor: 'start' | 'end';
}

/** Each layout's drawing, in its viewBox's units, which are pixels at the reading column's width. */
interface Layout {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  point: number;
  ring: number;
  dash: string;
  /** The labelled scores, by model, beside their points. */
  labels: Record<string, LabelPlace>;
  /** Sierra's early run, which shares one label: where its middle sits, as a day and a score. */
  note: { iso: string; score: number } | null;
  /** The band's label: its first line, and where both lines line up. */
  band: { title: string; anchor: 'middle' | 'end' };
  prediction: string;
}

const DESKTOP: Layout = {
  width: 584,
  height: 400,
  plot: { left: 44, right: 576, top: 40, bottom: 356 },
  point: 5.5,
  ring: 10,
  dash: '6 6',
  labels: {
    'Claude Sonnet 5': { dx: -6, dy: 50, anchor: 'end' },
    'Claude Opus 5': { dx: -30, dy: -22, anchor: 'end' },
    'Claude Fable 5.1': { dx: 52, dy: 56, anchor: 'start' },
    'Claude Opus 5.5': { dx: 40, dy: 34, anchor: 'start' },
    'Gemini 4 Argon': { dx: -8, dy: -34, anchor: 'end' },
  },
  note: { iso: '2025-12-01', score: 12 },
  band: { title: `Trend reaches ${BAR}`, anchor: 'middle' },
  prediction: `Prediction: by ${PREDICTION.label}`,
};

const PHONE: Layout = {
  width: 318,
  height: 350,
  plot: { left: 32, right: 314, top: 40, bottom: 306 },
  point: 4.5,
  ring: 8,
  dash: '5 5',
  labels: {
    'Claude Sonnet 5': { dx: -4, dy: 62, anchor: 'end' },
    'Claude Opus 5': { dx: -32, dy: -20, anchor: 'end' },
    'Claude Fable 5.1': { dx: 28, dy: 62, anchor: 'start' },
    'Claude Opus 5.5': { dx: 22, dy: 36, anchor: 'start' },
    'Gemini 4 Argon': { dx: -6, dy: -30, anchor: 'end' },
  },
  note: null,
  band: { title: `Reaches ${BAR}`, anchor: 'end' },
  prediction: `By ${PREDICTION.label}`,
};

const GRID = [0, 20, 40, 60, 80, 100];
/** Ten days between the trend's samples. */
const STEP = 10 * 24 * 60 * 60 * 1000;

/** A point's tooltip: its model, its score and its board. */
function pointTitle(row: Tau3Row): string {
  return `${row.model}, ${percent(row.score)} on ${TAU3_SOURCES[row.board].name}`;
}

/** Two decimals are finer than a pixel at either size, and keep the markup short. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The caption, built from the rows the chart draws (`forecast.ts`). */
const CAPTION = chartCaption(CLAUDE_SCORES, TOP_SCORE);

/** Every point the chart draws, by release date, for its text equivalent. */
const POINTS = [...CLAUDE_SCORES, TOP_SCORE].sort((a, b) => a.released.localeCompare(b.released));

/** Sierra's early run of scores, which shares one label: Claude's scores before the first one labelled on its own. */
function earlyRun(layout: Layout): Tau3Row[] {
  const first = CLAUDE_SCORES.findIndex((row) => row.model in layout.labels);
  return first < 0 ? [] : CLAUDE_SCORES.slice(0, first);
}

/** What the line, the band and the prediction show, in quarters. */
function fitSentence(): string {
  const { early, to } = quarterSpan(BAND.from, BAND.to);
  return (
    `The line, a straight-line fit in log-odds through all ${countWords(CLAUDE_SCORES.length)} Claude scores, is ` +
    `solid up to today, ${quarterYear(TODAY)}, and dashed after; it reaches ${BAR} ${early ? 'early in' : 'in'} ${to}. ` +
    `The band runs from ${quarterYear(BAND.from)}, where the fit through the Opus scores alone reaches ${BAR}, to ` +
    `${early ? 'early ' : ''}${to}. ` +
    `The prediction is by ${PREDICTION.label}.`
  );
}

export function Tau3Chart({ compact = false }: Tau3ChartProps) {
  const id = useId();
  const [ref, play] = usePlayOnce<HTMLElement>('tau3');
  const captionId = `${id}-caption`;
  const tableId = `${id}-table`;
  const layout = compact ? PHONE : DESKTOP;
  const { plot } = layout;
  const span = DOMAIN.to.getTime() - DOMAIN.from.getTime();
  const x = (date: Date) => round(plot.left + ((date.getTime() - DOMAIN.from.getTime()) / span) * (plot.right - plot.left));
  const y = (score: number) => round(plot.bottom - (score / 100) * (plot.bottom - plot.top));
  const at = (row: Tau3Row) => ({ cx: x(dayOf(row.released)), cy: y(row.score) });
  const trendAt = (time: number) => `${x(new Date(time))},${y(TAU3_FITS.claude.at(new Date(time)) * 100)}`;

  // The trend: solid from the first score to today, then dashed from today to where it reaches the bar.
  const first = dayOf(CLAUDE_SCORES[0]?.released ?? '2025-07-01').getTime();
  const solid: string[] = [];
  for (let t = first; t < TODAY.getTime(); t += STEP) solid.push(trendAt(t));
  solid.push(trendAt(TODAY.getTime()));
  const ahead: string[] = [];
  for (let t = TODAY.getTime(); t < BAND.to.getTime(); t += STEP) ahead.push(trendAt(t));
  ahead.push(`${x(BAND.to)},${y(TAU3_BAR * 100)}`);

  const bar = y(TAU3_BAR * 100);
  const band = { left: x(BAND.from), right: x(BAND.to) };
  const today = x(TODAY);
  const bracket = { left: x(PREDICTION.from), right: x(PREDICTION.to), top: plot.top - 8 };
  const latest = at(LATEST_CLAUDE);
  const run = earlyRun(layout);
  const bandWords = [layout.band.title, bandQuarters()];
  const bandX = layout.band.anchor === 'end' ? plot.right : round((band.left + band.right) / 2);
  const style: ChartStyle = { '--cd-tau3-count': CLAUDE_SCORES.length };

  return (
    <figure
      ref={ref}
      className={`cd-about-figure cd-about-chart${compact ? ' cd-about-figure--compact cd-about-chart--compact' : ''}`}
      data-play={play ?? undefined}
      style={style}
    >
      <div className="cd-about-frame cd-about-chart__frame">
        <div className="cd-about-chart__head">
          <p className="cd-about-figure-title cd-type-section">{`Claude’s τ³-Banking score, and when the trend reaches ${BAR}`}</p>
          <p className="cd-about-chart__subtitle cd-type-caption">
            {compact
              ? 'Bank customer-service tasks done right on the first try'
              : 'The share of a bank’s customer-service tasks each model gets right on the first try, by its release date'}
          </p>
          <p className="cd-about-chart__key cd-type-caption">
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-dot" aria-hidden="true" />
              Claude
            </span>
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-ring" aria-hidden="true" />
              Another lab
            </span>
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-dash" aria-hidden="true" />
              {compact ? 'Trend' : 'Trend through Claude’s scores'}
            </span>
            <span className="cd-about-chart__key-item">
              <span className="cd-about-chart__key-band" aria-hidden="true" />
              {compact ? `Reaches ${BAR}` : `When the trend reaches ${BAR}`}
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
            data-tau3-part="band"
            className="cd-about-chart__band"
            x={band.left}
            y={plot.top}
            width={round(band.right - band.left)}
            height={plot.bottom - plot.top}
          />
          {GRID.filter((score) => score !== TAU3_BAR * 100).map((score) => (
            <line
              key={score}
              data-tau3-part="grid"
              className="cd-about-chart__grid"
              x1={plot.left}
              x2={plot.right}
              y1={y(score)}
              y2={y(score)}
            />
          ))}
          {/* Each new year as a faint vertical, so a reader can place a point in its year at a glance. */}
          {QUARTERS.slice(1, -1)
            .filter((day) => day.getUTCMonth() === 0)
            .map((day) => (
              <line
                key={day.toISOString()}
                data-tau3-part="grid"
                className="cd-about-chart__grid"
                x1={x(day)}
                x2={x(day)}
                y1={plot.top}
                y2={plot.bottom}
              />
            ))}
          <line
            data-tau3-part="axis"
            className="cd-about-chart__axis-line"
            x1={plot.left}
            x2={plot.right}
            y1={plot.bottom}
            y2={plot.bottom}
          />
          {/* A tick at each quarter's start, taller where a year starts. */}
          {QUARTERS.map((day) => (
            <line
              key={day.toISOString()}
              data-tau3-part="tick"
              className="cd-about-chart__axis-line"
              x1={x(day)}
              x2={x(day)}
              y1={plot.bottom}
              y2={plot.bottom + (day.getUTCMonth() === 0 ? 22 : 5)}
            />
          ))}

          <line data-bar="" data-tau3-part="bar" className="cd-about-chart__bar" x1={plot.left} x2={plot.right} y1={bar} y2={bar} />
          <text data-tau3-part="bar-label" className="cd-about-chart__label cd-type-caption" x={plot.left + 6} y={bar - 8}>
            {`The bar: ${BAR}`}
          </text>

          <line
            data-today=""
            data-tau3-part="today"
            className="cd-about-chart__rule"
            x1={today}
            x2={today}
            y1={plot.top - 8}
            y2={plot.bottom}
          />
          <text
            data-tau3-part="today-label"
            className="cd-about-chart__label cd-type-caption"
            x={today}
            y={plot.top - 14}
            textAnchor="middle"
          >
            Today
          </text>

          {/* The prediction names a quarter, not a day: a bracket over the whole of it. */}
          <path
            data-bracket=""
            data-tau3-part="rule"
            className="cd-about-chart__rule cd-about-chart__bracket"
            d={`M${bracket.left} ${plot.top - 2} V${bracket.top} H${bracket.right} V${plot.top - 2}`}
          />
          <text
            data-tau3-part="prediction-date"
            className="cd-about-chart__label cd-type-caption"
            x={bracket.right}
            y={plot.top - 14}
            textAnchor="end"
          >
            {layout.prediction}
          </text>

          {bandWords.map((words, i) => (
            <text
              key={words}
              data-tau3-part="band-label"
              className={`${i === bandWords.length - 1 ? 'cd-about-chart__label' : 'cd-about-chart__axis'} cd-type-caption`}
              x={bandX}
              y={plot.bottom - 10 - 15 * (bandWords.length - 1 - i)}
              textAnchor={layout.band.anchor}
            >
              {words}
            </text>
          ))}

          <polyline data-trend="" data-tau3-part="trend" className="cd-about-chart__fit cd-about-chart__fit--past" points={solid.join(' ')} />
          <polyline
            data-fit=""
            data-tau3-part="fit"
            className="cd-about-chart__fit"
            points={ahead.join(' ')}
            strokeDasharray={layout.dash}
          />

          <circle data-point="top" data-tau3-part="top" className="cd-about-chart__top" {...at(TOP_SCORE)} r={layout.point}>
            <title>{pointTitle(TOP_SCORE)}</title>
          </circle>
          {/* In release order (`tau3.ts` sorts them), which is the order they appear in when the chart plays. */}
          {CLAUDE_SCORES.map((row, i) => (
            <circle
              key={row.model}
              data-point="claude"
              data-tau3-part="point"
              className="cd-about-chart__point"
              style={{ '--cd-tau3-i': i } as PointStyle}
              {...at(row)}
              r={layout.point}
            >
              <title>{pointTitle(row)}</title>
            </circle>
          ))}
          <circle data-ring="" data-tau3-part="ring" className="cd-about-chart__ring" cx={latest.cx} cy={latest.cy} r={layout.ring} />

          {/* Each labelled score beside its point, with a short leader: its model and score, then its board. */}
          {POINTS.filter((row) => row.model in layout.labels).map((row) => {
            const place = layout.labels[row.model] as LabelPlace;
            const point = at(row);
            const tx = round(point.cx + place.dx);
            const ty = round(point.cy + place.dy);
            const below = ty > point.cy;
            return (
              <g key={row.model} data-point-label="" data-tau3-part="point-label">
                <line
                  className="cd-about-chart__leader"
                  x1={point.cx}
                  y1={round(point.cy + (below ? 1 : -1) * (layout.point + 2))}
                  x2={tx}
                  y2={round(below ? ty - 13 : ty + 19)}
                />
                <text className="cd-about-chart__label cd-type-caption" x={tx} y={ty} textAnchor={place.anchor}>
                  {`${shortName(row)}, ${percent(row.score)}`}
                </text>
                <text className="cd-about-chart__axis cd-type-caption" x={tx} y={ty + 15} textAnchor={place.anchor}>
                  {row.board}
                </text>
              </g>
            );
          })}
          {layout.note && run.length > 0 ? (
            <text
              data-point-note=""
              data-tau3-part="point-label"
              className="cd-about-chart__axis cd-type-caption"
              x={x(dayOf(layout.note.iso))}
              y={y(layout.note.score)}
              textAnchor="middle"
            >
              {`${shortName(run[0] as Tau3Row)} to ${shortName(run[run.length - 1] as Tau3Row)}: ${run[0]?.board ?? ''}`}
            </text>
          ) : null}

          {GRID.map((score) => (
            <text
              key={score}
              data-tau3-part="score-label"
              className="cd-about-chart__axis cd-type-caption"
              x={plot.left - 8}
              y={y(score) + 4}
              textAnchor="end"
            >
              {`${score}%`}
            </text>
          ))}
          {/* Each quarter's name halfway along it, the prediction's in primary ink; the years under them. */}
          {QUARTERS.slice(0, -1).map((day, i) => {
            const next = QUARTERS[i + 1] as Date;
            const predicted = day.getTime() === PREDICTION.from.getTime();
            return (
              <text
                key={day.toISOString()}
                data-tau3-part="tick-label"
                className={`${predicted ? 'cd-about-chart__label' : 'cd-about-chart__axis'} cd-type-caption`}
                x={round((x(day) + x(next)) / 2)}
                y={plot.bottom + 17}
                textAnchor="middle"
              >
                {`Q${Math.floor(day.getUTCMonth() / 3) + 1}`}
              </text>
            );
          })}
          {YEARS.map(({ year, from, to }) => (
            <text
              key={year}
              data-tau3-part="tick-label"
              className="cd-about-chart__axis cd-type-caption"
              x={round((x(from) + x(to)) / 2)}
              y={plot.bottom + 36}
              textAnchor="middle"
            >
              {year}
            </text>
          ))}
        </svg>
        <div id={tableId} className="cd-sr-only">
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Released</th>
                <th scope="col">Score</th>
                <th scope="col">Board</th>
              </tr>
            </thead>
            <tbody>
              {POINTS.map((row) => (
                <tr key={row.model}>
                  <th scope="row">{row === TOP_SCORE ? `${row.model}, another lab` : row.model}</th>
                  <td>{monthYear(dayOf(row.released))}</td>
                  <td>{percent(row.score)}</td>
                  <td>{TAU3_SOURCES[row.board].name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{fitSentence()}</p>
        </div>
      </div>
      <figcaption id={captionId} className={`cd-about-figcaption ${compact ? 'cd-type-caption' : 'cd-type-article-caption'}`}>
        <span className="cd-about-fignum">Figure 1</span>{' '}
        <span>{CAPTION}</span>
      </figcaption>
    </figure>
  );
}
