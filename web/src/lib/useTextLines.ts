import { useLayoutEffect, useState, type RefObject } from 'react';

/** A run of the words, plain or in its own classes (a visitor's name set off in `cd-user-name`). */
export type TextPart = string | { text: string; className: string };

export interface TextLinesProbe {
  /** The words as the page writes them, known before the read lands. */
  parts: readonly TextPart[];
  /** The real element's classes, which give it its type and how it wraps. */
  className: string;
}

/**
 * How many lines the page's own words take at the width of `box`, in the type `className` gives them
 * and the fonts this browser has, so a skeleton draws as many lines as the words will wrap to on
 * every platform, rather than a count read off one machine. Until `box` is laid out it is
 * `fallback`; it is measured again when `box` resizes and when fonts finish loading.
 *
 * The words go into a probe only for the length of the measurement: an invisible, inert element
 * appended to `box` and removed in the same task, so no frame and no reader ever meets them.
 */
export function useTextLines(box: RefObject<HTMLElement | null>, { parts, className }: TextLinesProbe, fallback: number): number {
  const [lines, setLines] = useState<number>();
  const key = JSON.stringify(parts);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected) return;
      const style = getComputedStyle(element);
      const width = element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      if (width <= 0) return;
      const probe = document.createElement('p');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${width}px`, margin: '0', padding: '0' });
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
        const lineHeight = Number.parseFloat(getComputedStyle(probe).lineHeight);
        if (lineHeight > 0) setLines(Math.max(1, Math.round(probe.getBoundingClientRect().height / lineHeight)));
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer?.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [box, key, className]);
  return lines ?? fallback;
}
