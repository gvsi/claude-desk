import { useLayoutEffect, useRef, useState } from 'react';

import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { measureControlWidth } from '../Skeleton/useControlWidth.ts';
import { SEED_OWNER_NAME, reviewerBarWords } from './ReviewerBar.tsx';

import '../Button/Button.css';
import './ReviewerBar.css';

/** The real bar's Start over: an inline ghost `Button`. */
const START_OVER_CLASS = 'cd-button cd-button--ghost cd-button--inline cd-type-control';

/** The demo bar's naturally wrapped line boxes and its Start over control. */
export function ReviewerBarSkeleton({ ownerName = SEED_OWNER_NAME }: { ownerName?: string | null } = {}) {
  const text = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ lines: 1, controlWidth: 0 });
  const words = reviewerBarWords(ownerName);
  const copy = `${words.beforeName}${words.ownerName ?? words.noOwner}${words.afterName}${words.disclosure}`;
  const { startOver } = words;
  useLayoutEffect(() => {
    const container = text.current!;
    let live = true;
    const context = document.createElement('canvas').getContext('2d')!;
    const measure = () => {
      if (!live) return;
      const bar = container.parentElement!;
      // Measure the control in this pass: a child's layout-effect state update has not yet
      // reserved its width when this first measurement runs.
      const { width: controlWidth, font } = measureControlWidth(bar, { label: startOver, className: START_OVER_CLASS }, context);
      const style = getComputedStyle(bar);
      const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'columnGap'] as const;
      const available = bar.getBoundingClientRect().width - controlWidth - edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
      const probe = document.createElement('p');
      probe.className = 'cd-reviewer-bar__text';
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      probe.textContent = copy;
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${Math.max(0, available)}px` });
      bar.append(probe);
      try {
        const range = document.createRange();
        range.selectNodeContents(probe);
        const lines = new Set([...range.getClientRects()].map((rect) => rect.top)).size;
        setLayout((previous) => (previous.lines === lines && previous.controlWidth === controlWidth ? previous : { lines, controlWidth }));
        return font;
      } finally {
        probe.remove();
      }
    };
    const controlFont = measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container.parentElement!);
    // Empty shapes do not request the face themselves; remeasure when it becomes available.
    void document.fonts.load(getComputedStyle(container).font, copy).then(measure, measure);
    if (controlFont) void document.fonts.load(controlFont, startOver).then(measure, measure);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, [copy, startOver]);

  return (
    <div className="cd-reviewer-bar cd-type-meta" data-skeleton-anchor="reviewer-bar">
      <div ref={text} className="cd-reviewer-bar__text">
        {Array.from({ length: layout.lines }, (_, i) => <Skeleton key={i} shape="line" text="meta" width={i === 0 ? 'min(100%, 430px)' : '75%'} />)}
      </div>
      <div className="cd-reviewer-bar__actions">
        <Skeleton shape="block" width={layout.controlWidth} height="var(--size-control)" />
      </div>
    </div>
  );
}
