/**
 * A document's table other than the readiness scale, such as the proposal's measures: a table on a desktop,
 * each row led by its first cell, and on a phone a list, each row a term with its second cell under it and every
 * later cell under its column's heading.
 */
import { Fragment } from 'react';

import { inlineText, type Block } from '../documents.ts';
import { Inlines } from '../Inlines.tsx';

import '../reader.css';

type Table = Extract<Block, { kind: 'table' }>;

export interface MeasuresTableProps {
  table: Table;
  /** The phone layout: a definition list instead of a table. */
  compact?: boolean;
  /**
   * The table's place among the document's blocks. When given, each cell carries `data-doc-text="<block>.<cell>"`,
   * cells counted as `documentText` lists them: the header's, then each row's.
   */
  block?: number;
  /** Set column widths, in percent, for the table on a laptop (a colgroup on a fixed layout); none sizes them to its words. */
  widths?: readonly number[];
}

export function MeasuresTable({ table, compact = false, block, widths }: MeasuresTableProps) {
  const columns = table.head.length;
  const docText = (cell: number) => (block === undefined ? {} : { 'data-doc-text': `${block}.${cell}` });
  const cellOf = (r: number, c: number) => docText(columns + r * columns + c);

  if (!compact) {
    return (
      <table className={`cd-about-measures${widths ? ' cd-about-measures--set' : ''} cd-type-body`}>
        {widths ? (
          <colgroup>
            {widths.map((width, c) => (
              <col key={c} style={{ width: `${width}%` }} />
            ))}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {table.head.map((cell, c) => (
              <th key={c} scope="col" className="cd-type-caption" {...docText(c)}>
                <Inlines inlines={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row" {...cellOf(r, c)}>
                    <Inlines inlines={cell} />
                  </th>
                ) : (
                  <td key={c} {...cellOf(r, c)}>
                    <Inlines inlines={cell} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="cd-about-measures-list">
      {/* The table's own headings, for a screen reader; the list repeats the ones it shows as labels. */}
      <p className="cd-sr-only">
        {table.head.map((cell, c) => (
          <Fragment key={c}>
            {c > 0 ? ' ' : null}
            <span {...docText(c)}>
              <Inlines inlines={cell} />
            </span>
          </Fragment>
        ))}
      </p>
      <dl className="cd-about-measures-list__items">
        {table.rows.map((row, r) => (
          <div key={r} className="cd-about-measures-list__item">
            {row.map((cell, c) => {
              if (c === 0) {
                return (
                  <dt key={c} className="cd-type-section" {...cellOf(r, c)}>
                    <Inlines inlines={cell} />
                  </dt>
                );
              }
              if (c === 1) {
                return (
                  <dd key={c} className="cd-about-measures-list__shows cd-type-body" {...cellOf(r, c)}>
                    <Inlines inlines={cell} />
                  </dd>
                );
              }
              return (
                <dd key={c} className="cd-about-measures-list__more cd-type-body">
                  <span className="cd-about-measures-list__label cd-type-caption" data-label="">
                    {inlineText(table.head[c] ?? [])}
                  </span>
                  <span {...cellOf(r, c)}>
                    <Inlines inlines={cell} />
                  </span>
                </dd>
              );
            })}
          </div>
        ))}
      </dl>
    </div>
  );
}
