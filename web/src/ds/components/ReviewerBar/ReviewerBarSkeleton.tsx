import { useLayoutEffect, useRef, useState } from 'react';

import { Skeleton } from '../Skeleton/Skeleton.tsx';

import '../Button/Button.css';
import './ReviewerBar.css';

// Before Desks arrive, the frame stands in for the fresh demo copy.
const FRESH_COPY_TEXT = "You're Maria Rivera today. This is a concept prototype.";

/** The demo bar's naturally wrapped line boxes and its Start over control. */
export function ReviewerBarSkeleton() {
  const text = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<number[]>([]);
  useLayoutEffect(() => {
    const container = text.current!;
    let live = true;
    const measure = () => {
      if (!live) return;
      // Let the browser wrap the real words in the current font and available width. Unlike a
      // control's unwrapped width, this also accounts for word breaks near the wrap threshold.
      const probe = document.createElement('p');
      probe.className = 'cd-reviewer-bar__text';
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      probe.textContent = FRESH_COPY_TEXT;
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${container.getBoundingClientRect().width}px` });
      container.parentElement!.append(probe);
      try {
        const range = document.createRange();
        range.selectNodeContents(probe);
        const widths = [...range.getClientRects()].map((rect) => rect.width);
        setLines((previous) => previous.length === widths.length && previous.every((width, i) => width === widths[i]) ? previous : widths);
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // Empty shapes do not request the face themselves; remeasure when it becomes available.
    void document.fonts.load(getComputedStyle(container).font, FRESH_COPY_TEXT).then(measure, measure);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, []);

  return (
    <div className="cd-reviewer-bar cd-type-meta" data-skeleton-anchor="reviewer-bar">
      <div ref={text} className="cd-reviewer-bar__text">
        {lines.length === 0 ? <Skeleton shape="line" text="meta" /> : lines.map((width, i) => <Skeleton key={i} shape="line" text="meta" width={width} />)}
      </div>
      <Skeleton shape="block" measure={{ label: 'Start over', className: 'cd-button cd-button--ghost cd-button--inline cd-type-control' }} height="var(--size-control)" />
    </div>
  );
}
