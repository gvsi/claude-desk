import { MARK_GEOMETRY } from './markGeometry.ts';

import './Mark.css';

export interface MarkProps {
  /** Drawn size in px; 20 (the default) in the sidebar, 16 at the smallest, 32 alone in an avatar's place on the intro illustration's reply card. */
  size?: 16 | 20 | 24 | 32;
}

/**
 * The Claude Desk mark: a hand-drawn service bell on a white tile, drawn from `MARK_GEOMETRY` in the
 * mark's fixed colors. Decorative (`aria-hidden`): it always sits beside the name written out, in
 * the `Wordmark` or "Powered by Claude Desk".
 */
export function Mark({ size = 20 }: MarkProps) {
  const { viewBox, tile, art, clay, ink } = MARK_GEOMETRY;
  return (
    <svg className="cd-mark" aria-hidden="true" focusable="false" width={size} height={size} viewBox={viewBox}>
      <rect className="cd-mark__tile" {...tile} />
      <g transform={art}>
        <g className="cd-mark__clay">
          {clay.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
        <g className="cd-mark__ink">
          {ink.map((shape, index) =>
            'd' in shape ? <path key={index} d={shape.d} /> : <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />,
          )}
        </g>
      </g>
    </svg>
  );
}

export interface WordmarkProps {
  /** Adds "Beta" beneath the name, as in the owner app's sidebar. */
  beta?: boolean;
}

/** "Claude Desk" in serif, the product's name as a wordmark. Place it beside a `Mark`. */
export function Wordmark({ beta = false }: WordmarkProps) {
  return (
    <span className="cd-wordmark">
      <span className="cd-wordmark__name cd-type-wordmark">Claude Desk</span>
      {beta ? <span className="cd-wordmark__beta cd-type-beta">Beta</span> : null}
    </span>
  );
}
