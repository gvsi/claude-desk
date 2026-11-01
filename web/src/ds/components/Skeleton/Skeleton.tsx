import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { useControlWidth, type ControlMeasurement } from './useControlWidth.ts';

import '../Card/Card.css';
import './Skeleton.css';

/** The type style a line stands in for: its line box is that style's line height. */
export type SkeletonText =
  | 'greeting'
  | 'page-title'
  | 'figure'
  | 'figure-small'
  | 'summary'
  | 'brand-name'
  | 'section'
  | 'control'
  | 'body'
  | 'message'
  | 'reply'
  | 'meta'
  | 'caption'
  | 'pill';

export interface SkeletonProps {
  shape: 'line' | 'block' | 'circle';
  /** line: the type style it stands in for (default 'body'). */
  text?: SkeletonText;
  /** line and block: px, or any CSS length or percentage. A line defaults to '100%'. */
  width?: number | string;
  /** block: measure a text-sized control in its real CSS and font, without drawing its label. */
  measure?: ControlMeasurement;
  /** block: px, or any CSS length. */
  height?: number | string;
  /** circle: the diameter in px (default 28, `size-avatar`). */
  size?: number;
  /** block: its corners (default 'control'). */
  radius?: 'control' | 'card' | 'composer' | 'full';
  /** Names the shape for screen tests, as `data-skeleton-anchor`. */
  anchor?: string;
  /** For the screen's own layout: a grid area, a breakpoint rule. */
  className?: string;
}

/** The sweep's keyframes, which every shape runs. */
const SWEEP = 'cd-skeleton-sweep';

/**
 * Starts a shape's sweep at the document's time 0, so it is at the same point of the loop as every
 * other shape, whenever it mounted. A shape under reduced motion runs no sweep and is left alone.
 */
function syncSweep(shape: Element): void {
  if (typeof shape.getAnimations !== 'function') return;
  for (const animation of shape.getAnimations()) {
    if ((animation as CSSAnimation).animationName === SWEEP && animation.startTime !== 0) animation.startTime = 0;
  }
}

/**
 * Places the band on each shape in viewport coordinates: each takes its left edge in the viewport
 * as `--cd-skeleton-x`, which the sweep subtracts, so every shape shows the band at the same
 * viewport x. Every left edge is read before any is written, and every one is written before the
 * sweeps are read, so the page is laid out and styled once. Each sweep is put back in phase too, as
 * a shape that a breakpoint hid and shows again starts a new one.
 */
export function placeBands(shapes: readonly HTMLElement[]): void {
  const lefts = shapes.map((shape) => shape.getBoundingClientRect().left);
  shapes.forEach((shape, i) => shape.style.setProperty('--cd-skeleton-x', `${lefts[i] ?? 0}px`));
  shapes.forEach(syncSweep);
}

/** The class names, with the screen's own after them. */
function classes(...names: (string | undefined)[]): string {
  return names.filter((name) => name !== undefined && name !== '').join(' ');
}

/**
 * One quiet shape where a part of a page will be while it loads: a line (a pill centred in its type
 * style's line box, so it shares its top edge with the words that replace it), a block or a circle.
 * It is drawn only, hidden from assistive technology, and carries the sweep of its `SkeletonScreen`.
 */
export function Skeleton({ shape, text = 'body', width, measure, height, size, radius = 'control', anchor, className }: SkeletonProps) {
  // The element that paints: a line's pill, or the block or circle itself.
  const painted = useRef<HTMLSpanElement>(null);
  const controlWidth = useControlWidth(painted, measure);
  // As it mounts, in the frame it is first drawn in: the band at its place, and the sweep in phase.
  useLayoutEffect(() => {
    if (painted.current) placeBands([painted.current]);
  }, [shape, width, controlWidth]);

  if (shape === 'line') {
    return (
      <span
        className={classes('cd-skeleton-line', `cd-skeleton-line--${text}`, `cd-type-${text}`, className)}
        style={{ width: width ?? '100%' }}
        aria-hidden="true"
        data-skeleton-anchor={anchor}
      >
        <span ref={painted} className="cd-skeleton cd-skeleton-line__pill" />
      </span>
    );
  }
  if (shape === 'circle') {
    return (
      <span
        ref={painted}
        className={classes('cd-skeleton', 'cd-skeleton--circle', className)}
        style={size === undefined ? undefined : { width: size, height: size }}
        aria-hidden="true"
        data-skeleton-anchor={anchor}
      />
    );
  }
  return (
    <span
      ref={painted}
      className={classes('cd-skeleton', 'cd-skeleton--block', `cd-skeleton--radius-${radius}`, className)}
      style={{ width: controlWidth ?? width, height }}
      aria-hidden="true"
      data-skeleton-anchor={anchor}
    />
  );
}

export interface SkeletonCardProps {
  /** As `Card`'s: 20 by default, 16 for a compact card, 0 for rows that pad themselves. */
  padding?: 0 | 16 | 20;
  anchor?: string;
  className?: string;
  children: ReactNode;
}

/** The real card's border, fill, radius and padding, holding shapes. */
export function SkeletonCard({ padding = 20, anchor, className, children }: SkeletonCardProps) {
  return (
    <div
      className={classes('cd-card', `cd-card--padding-${padding}`, 'cd-skeleton-card', className)}
      aria-hidden="true"
      data-skeleton-anchor={anchor}
    >
      {children}
    </div>
  );
}
