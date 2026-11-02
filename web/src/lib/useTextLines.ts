import { useLayoutEffect, useState, type RefObject } from 'react';

/** A run of the words, plain or in its own classes (a visitor's name set off in `cd-user-name`). */
export type TextPart = string | { text: string; className: string };

export interface TextLinesProbe {
  /** The words as the page writes them, known before the read lands. */
  parts: readonly TextPart[];
  /** The real element's classes, which give it its type, its padding and how it wraps. */
  className: string;
}

/** How the words lay out: their lines, and the height of the element holding them, padding included. */
export interface TextBox {
  lines: number;
  height: number | undefined;
}

/**
 * How the page's own words lay out at the width of `box`, in the type, padding and wrapping
 * `className` gives them and the fonts this browser has, so a skeleton draws as many lines, and as
 * tall a block, as the words will take on every platform, rather than a count read off one
 * machine. Until `box` is laid out it is `fallback` lines; it is measured again when `box`
 * resizes and when fonts finish loading. A caller that changes `box`'s width itself, from a
 * measurement of its own in the same commit, passes that value as `layoutKey`: the box is measured
 * again in the commit that applies it, before the browser paints, where a resize alone would be
 * caught only after the first frame.
 *
 * The words go into a probe only for the length of the measurement: an invisible, inert element as
 * wide as `box`, appended to it and removed in the same task, so no frame and no reader ever meets
 * them.
 */
export function useTextBox(
  box: RefObject<HTMLElement | null>,
  { parts, className }: TextLinesProbe,
  fallback: number,
  layoutKey?: unknown,
): TextBox {
  const [measured, setMeasured] = useState<TextBox>();
  const key = JSON.stringify(parts);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected || element.closest('[data-state="leaving"]')) return;
      const style = getComputedStyle(element);
      const horizontal = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const;
      const width = element.getBoundingClientRect().width - horizontal.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
      if (width <= 0) return;
      const probe = document.createElement('p');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', boxSizing: 'border-box', width: `${width}px`, margin: '0' });
      for (const part of JSON.parse(key) as TextPart[]) {
        if (typeof part === 'string') probe.append(part);
        else {
          const span = document.createElement('span');
          span.className = part.className;
          span.textContent = part.text;
          probe.append(span);
        }
      }
      element.append(probe);
      try {
        const own = getComputedStyle(probe);
        const lineHeight = Number.parseFloat(own.lineHeight);
        const height = probe.getBoundingClientRect().height;
        const edges = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
        const inner = height - edges.reduce((sum, edge) => sum + (Number.parseFloat(own[edge]) || 0), 0);
        if (lineHeight > 0) {
          const lines = Math.max(1, Math.round(inner / lineHeight));
          setMeasured((was) => (was?.lines === lines && was.height === height ? was : { lines, height }));
        }
        // Variable font settings can make the shorthand empty; its face is still requestable.
        return own.font || `${own.fontStyle} ${own.fontWeight} ${own.fontSize} ${own.fontFamily}`;
      } finally {
        probe.remove();
      }
    };
    const font = measure();
    const text = parts.map((part) => typeof part === 'string' ? part : part.text).join('');
    if (font) void document.fonts.load(font, text).then(measure, measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer?.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [box, key, className, layoutKey]);
  return measured ?? { lines: fallback, height: undefined };
}

/** How many lines the page's own words take at the width of `box` (see `useTextBox`). */
export function useTextLines(box: RefObject<HTMLElement | null>, probe: TextLinesProbe, fallback: number, layoutKey?: unknown): number {
  return useTextBox(box, probe, fallback, layoutKey).lines;
}
