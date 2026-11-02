import { useLayoutEffect, useRef, useState } from 'react';

import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { measureControlWidth } from '../Skeleton/useControlWidth.ts';
import { SEED_OWNER_NAME, reviewerBarWords } from './ReviewerBar.tsx';

import '../Button/Button.css';
import './ReviewerBar.css';

/** The real bar's Start over: an inline ghost `Button`. */
const START_OVER_CLASS = 'cd-button cd-button--ghost cd-button--inline cd-type-control';

/** The owner app's Demo inbox in the bar: a quiet `DemoInboxSheet` button with its count. */
const INBOX = {
  label: 'Demo inbox',
  className: START_OVER_CLASS,
  contentClassName: 'cd-demo-inbox-sheet__button cd-demo-inbox-sheet__button--quiet',
  suffix: { label: '1', className: 'cd-count-pill cd-type-count' },
};

/**
 * The Demo inbox's shape in the landed bar while its first read is out: the same block the bar's
 * loading shapes draw before Start over, so Start over keeps its place when the button lands.
 */
export function ReviewerBarInboxSkeleton() {
  return <Skeleton shape="block" measure={INBOX} height="var(--size-control)" anchor="inbox" />;
}

/** The bar's controls wrap under its words on a phone when the screen adds its own. */
const PHONE = '(max-width: 639.98px)';

/**
 * The demo bar's naturally wrapped line boxes and its Start over control; with `inbox`, the owner
 * app's Demo inbox button before it, anchored `inbox`.
 */
export function ReviewerBarSkeleton({ ownerName = SEED_OWNER_NAME, inbox = false }: { ownerName?: string; inbox?: boolean } = {}) {
  const text = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ lines: 1, controlWidth: 0, inboxWidth: 0 });
  const words = reviewerBarWords(ownerName);
  const copy = `${words.beforeName}${words.ownerName}${words.afterName}${words.disclosure}`;
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
      const inboxWidth = inbox ? measureControlWidth(bar, INBOX, context).width : 0;
      const style = getComputedStyle(bar);
      const actionsGap = Number.parseFloat(getComputedStyle(container.nextElementSibling!).columnGap) || 0;
      const controls = controlWidth + (inbox ? inboxWidth + actionsGap : 0);
      // With the inbox, a phone's bar gives the words a line of their own.
      const wraps = inbox && window.matchMedia(PHONE).matches;
      const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', ...(wraps ? [] : ['columnGap' as const])] as const;
      const available = bar.getBoundingClientRect().width - (wraps ? 0 : controls) - edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
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
        setLayout((previous) =>
          previous.lines === lines && previous.controlWidth === controlWidth && previous.inboxWidth === inboxWidth ? previous : { lines, controlWidth, inboxWidth },
        );
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
  }, [copy, startOver, inbox]);

  return (
    <div className={`cd-reviewer-bar cd-type-meta${inbox ? ' cd-reviewer-bar--with-actions' : ''}`} data-skeleton-anchor="reviewer-bar">
      <div ref={text} className="cd-reviewer-bar__text">
        {Array.from({ length: layout.lines }, (_, i) => <Skeleton key={i} shape="line" text="meta" width={i === 0 ? 'min(100%, 430px)' : '75%'} />)}
      </div>
      <div className="cd-reviewer-bar__actions">
        {inbox ? <Skeleton shape="block" width={layout.inboxWidth} height="var(--size-control)" anchor="inbox" /> : null}
        <Skeleton shape="block" width={layout.controlWidth} height="var(--size-control)" />
      </div>
    </div>
  );
}
