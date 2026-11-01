import { useLayoutEffect, useRef, useState } from 'react';

import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { rivera } from '../../fixtures/rivera.ts';
import { reviewerBarWords } from './ReviewerBar.tsx';

import '../Button/Button.css';
import './ReviewerBar.css';

/** The demo bar's naturally wrapped line boxes and its Start over control. */
export function ReviewerBarSkeleton({ ownerName = rivera.business.ownerName }: { ownerName?: string } = {}) {
  const text = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ lines: 1, controlWidth: 0 });
  const words = reviewerBarWords(ownerName);
  const copy = `${words.beforeName}${words.ownerName}${words.afterName}${words.disclosure}`;
  useLayoutEffect(() => {
    const container = text.current!;
    let live = true;
    const measure = () => {
      if (!live) return;
      const bar = container.parentElement!;
      // Measure the control in this pass: a child's layout-effect state update has not yet
      // reserved its width when this first measurement runs.
      const control = document.createElement('button');
      control.className = 'cd-button cd-button--ghost cd-button--inline cd-type-control';
      control.textContent = 'Start over';
      control.inert = true;
      control.setAttribute('aria-hidden', 'true');
      Object.assign(control.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', maxWidth: 'none' });
      bar.append(control);
      const style = getComputedStyle(bar);
      const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'columnGap'] as const;
      const controlWidth = control.getBoundingClientRect().width;
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
        setLayout((previous) => previous.lines === lines && previous.controlWidth === controlWidth ? previous : { lines, controlWidth });
        return getComputedStyle(control).font;
      } finally {
        probe.remove();
        control.remove();
      }
    };
    const controlFont = measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container.parentElement!);
    // Empty shapes do not request the face themselves; remeasure when it becomes available.
    void document.fonts.load(getComputedStyle(container).font, copy).then(measure, measure);
    if (controlFont) void document.fonts.load(controlFont, 'Start over').then(measure, measure);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, [copy]);

  return (
    <div className="cd-reviewer-bar cd-type-meta" data-skeleton-anchor="reviewer-bar">
      <div ref={text} className="cd-reviewer-bar__text">
        {Array.from({ length: layout.lines }, (_, i) => <Skeleton key={i} shape="line" text="meta" width={i === 0 ? 'min(100%, 430px)' : '75%'} />)}
      </div>
      <Skeleton shape="block" width={layout.controlWidth} height="var(--size-control)" />
    </div>
  );
}
