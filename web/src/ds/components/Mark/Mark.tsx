import { Pill } from '../Pill/Pill.tsx';
import { MARK_GEOMETRY } from './markGeometry.ts';

import './Mark.css';

export type MarkProps = {
  /**
   * Drawn size in px: 20 (the default) in the top bars and beside a name, 16 in "Powered by Claude
   * Desk", 32 alone in an avatar's place on the intro illustration's reply card, 36 in the sidebar's
   * lockup.
   */
  size?: 16 | 20 | 24 | 32 | 36;
} & (
  | {
      /**
       * The ground under the bell, which has no tile: `dark` (the default, every ground in the app)
       * draws its ink light; `light` keeps the drawing's dark ink, as on the intro illustration's
       * light card.
       */
      ground?: 'dark' | 'light';
      tile?: false;
    }
  | {
      /** The white tile behind the bell, with the drawing's dark ink: only on the About pages' top bar. */
      tile: true;
      ground?: never;
    }
);

/**
 * The Claude Desk mark: a hand-drawn service bell, drawn from `MARK_GEOMETRY` in the mark's fixed
 * colors. With no tile, its clay dome under ink lines that are light on a dark ground and dark on a
 * light one; with `tile`, on its white tile in the drawing's own colors. Decorative (`aria-hidden`):
 * it always sits beside the name written out, in the `Wordmark` or "Powered by Claude Desk".
 */
export function Mark({ size = 20, ground = 'dark', tile = false }: MarkProps) {
  const { viewBox, tile: tileShape, art, clay, ink } = MARK_GEOMETRY;
  return (
    <svg
      className={`cd-mark cd-mark--${tile ? 'tile' : ground}`}
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox={viewBox}
    >
      {tile ? <rect className="cd-mark__tile" {...tileShape} /> : null}
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
  /**
   * Adds the "Preview" badge, a `Pill` in capitals, to the name's right: the Claude Desk lockup, as in
   * the owner app's sidebar, the About pages' desktop top bar and the intro dialog's brand row.
   */
  preview?: boolean;
}

/** "Claude Desk" in serif, the product's name as a wordmark, on one line. Place it beside a `Mark`. */
export function Wordmark({ preview = false }: WordmarkProps) {
  return (
    <span className="cd-wordmark">
      <span className="cd-wordmark__name cd-type-wordmark">Claude Desk</span>
      {preview ? <Pill caps>Preview</Pill> : null}
    </span>
  );
}
