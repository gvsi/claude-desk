/**
 * The capability prediction's readiness table, drawn as a scale: each axis on a row with its rating marked on
 * four steps (Lagging, Early, Gated, Near) and said in words, then its evidence and what to watch for. It reads
 * the table that follows `<!-- figure: readiness -->`, whose columns are the axis, its readiness, the evidence
 * and what to watch for; a rating outside the four steps throws, so the page can't mark a step the scale lacks.
 */
import { Fragment } from 'react';

import { inlineText, type Block, type Inline } from '../documents.ts';
import { Inlines } from '../Inlines.tsx';

import '../reader.css';

/** The scale's steps, from furthest to nearest. */
export const READINESS_STEPS = ['Lagging', 'Early', 'Gated', 'Near'] as const;

export type ReadinessStep = (typeof READINESS_STEPS)[number];

type Table = Extract<Block, { kind: 'table' }>;

export interface ReadinessRow {
  axis: Inline[];
  rating: ReadinessStep;
  evidence: Inline[];
  watch: Inline[];
}

/** The table's rows as axes on the scale. Throws on a table of other columns or a rating not on the scale. */
export function readinessRows(table: Table): ReadinessRow[] {
  if (table.head.length !== 4) {
    throw new Error(`the readiness table has ${table.head.length} columns, not axis, readiness, evidence and watch for`);
  }
  return table.rows.map(([axis = [], rating = [], evidence = [], watch = []]) => {
    const word = inlineText(rating);
    // One plain word: a rating in bold or with a link would be markup the scale can't show.
    const plain = rating.length === 1 && rating[0]?.kind === 'text';
    const step = READINESS_STEPS.find((name) => name === word);
    if (!step || !plain) {
      throw new Error(`“${inlineText(axis)}” is rated “${word}”, not one of ${READINESS_STEPS.join(', ')}`);
    }
    return { axis, rating: step, evidence, watch };
  });
}

export interface ReadinessScaleProps {
  /** The table after the readiness marker. */
  table: Table;
  /** The phone layout: each axis's name and rating on one line, the scale under them. */
  compact?: boolean;
  /**
   * The table's place among the document's blocks. When given, each cell carries `data-doc-text="<block>.<cell>"`,
   * cells counted as `documentText` lists them: the header's, then each row's.
   */
  block?: number;
}

export function ReadinessScale({ table, compact = false, block }: ReadinessScaleProps) {
  const rows = readinessRows(table);
  const columns = table.head.length;
  const docText = (cell: number) => (block === undefined ? {} : { 'data-doc-text': `${block}.${cell}` });
  const watchFor = inlineText(table.head[3] ?? []);

  return (
    <figure
      className={`cd-about-figure cd-about-readiness${compact ? ' cd-about-figure--compact cd-about-readiness--compact' : ''}`}
      aria-label="Readiness by axis"
    >
      {/* The table's own headings, for a screen reader; the scale shows them as its layout. */}
      <p className="cd-sr-only">
        {table.head.map((cell, i) => (
          <Fragment key={i}>
            {i > 0 ? ' ' : null}
            <span {...docText(i)}>
              <Inlines inlines={cell} />
            </span>
          </Fragment>
        ))}
      </p>
      <div className="cd-about-readiness__legend">
        <span className="cd-about-readiness__steps" data-steps="">
          {READINESS_STEPS.map((step) => (
            <span key={step} className="cd-about-readiness__step cd-type-caption">
              {step}
            </span>
          ))}
        </span>
      </div>
      <ol className="cd-about-readiness__axes">
        {rows.map((row, r) => {
          const cell = (c: number) => docText(columns + r * columns + c);
          const name = (
            <span className="cd-about-readiness__name cd-type-section" data-axis-name="" {...cell(0)}>
              <Inlines inlines={row.axis} />
            </span>
          );
          const rating = (
            <span className="cd-about-readiness__rating cd-type-meta" data-rating="" {...cell(1)}>
              {row.rating}
            </span>
          );
          const track = (
            <span className="cd-about-readiness__track" aria-hidden="true">
              <span className="cd-about-readiness__track-line" />
              {READINESS_STEPS.map((step) => (
                <span
                  key={step}
                  className={`cd-about-readiness__stop${step === row.rating ? ' cd-about-readiness__stop--on' : ''}`}
                  data-stop=""
                  {...(step === row.rating ? { 'data-on': '' } : {})}
                />
              ))}
            </span>
          );
          return (
            <li key={r} className="cd-about-readiness__axis" data-axis="">
              {compact ? (
                <>
                  <div className="cd-about-readiness__top">
                    {name}
                    {rating}
                  </div>
                  {track}
                </>
              ) : (
                <div className="cd-about-readiness__top">
                  {name}
                  {track}
                  {rating}
                </div>
              )}
              <p className="cd-about-readiness__evidence cd-type-message" data-evidence="" {...cell(2)}>
                <Inlines inlines={row.evidence} />
              </p>
              <p className="cd-about-readiness__watch cd-type-article-caption" data-watch="">
                <span className="cd-about-readiness__watch-label">{watchFor}</span>
                <span {...cell(3)}>
                  <Inlines inlines={row.watch} />
                </span>
              </p>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
