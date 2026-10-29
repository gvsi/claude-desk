import { MARK_GEOMETRY } from './markGeometry.ts';

import './Mark.css';

export interface MarkProps {
  /** Drawn size in px; 20 (the default) in the sidebar, 16 at the smallest, 18 on the intro illustration's reply card. */
  size?: 16 | 18 | 20 | 24;
}

/**
 * The Claude Desk mark, stroked in clay. Decorative (`aria-hidden`): it always sits beside the
 * name written out, in the `Wordmark` or "Powered by Claude Desk".
 */
export function Mark({ size = 20 }: MarkProps) {
  const { viewBox, rect, path, strokeWidth, strokeLinecap, strokeLinejoin } = MARK_GEOMETRY;
  return (
    <svg
      className="cd-mark"
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      strokeWidth={strokeWidth}
      strokeLinecap={strokeLinecap}
      strokeLinejoin={strokeLinejoin}
    >
      <rect {...rect} />
      <path d={path} />
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
