import { useRef, type ReactNode } from 'react';

import { useTextLines } from '../../../lib/useTextLines.ts';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { useControlWidth } from '../Skeleton/useControlWidth.ts';

import './PageHeader.css';

export interface PageHeaderSkeletonProps {
  /** Known words, measured without drawing them, so desktop actions wrap as the real header's do. */
  subtitle?: string;
  subtitleLines?: number | { wide: number; phone: number };
  /** True draws the default control; a shape can instead use the real action's measured width. */
  actions?: ReactNode;
  actionsBelowOnPhone?: boolean;
  hideSubtitleOnPhone?: boolean;
}

/** PageHeader's own line boxes and responsive action placement, without words. */
export function PageHeaderSkeleton({
  subtitle,
  subtitleLines = 1,
  actions = false,
  actionsBelowOnPhone = false,
  hideSubtitleOnPhone = false,
}: PageHeaderSkeletonProps) {
  const text = useRef<HTMLDivElement>(null);
  const subtitleBox = useRef<HTMLDivElement>(null);
  const subtitleWidth = useControlWidth(text, subtitle === undefined ? undefined : {
    label: subtitle, className: 'cd-page-header__subtitle cd-type-body', tagName: 'span',
  });
  // Its lines are counted again once the column takes the subtitle's width, in that same commit, so the
  // first frame already draws them as they stay.
  const lines = useTextLines(subtitleBox, { parts: [subtitle ?? ''], className: 'cd-page-header__subtitle cd-type-body' }, 1, subtitleWidth);
  const wide = subtitle === undefined ? (typeof subtitleLines === 'number' ? subtitleLines : subtitleLines.wide) : lines;
  const phone = subtitle === undefined ? (typeof subtitleLines === 'number' ? subtitleLines : subtitleLines.phone) : lines;
  const modifiers = `${actionsBelowOnPhone ? ' cd-page-header--actions-below' : ''}${hideSubtitleOnPhone ? ' cd-page-header--no-phone-subtitle' : ''}`;
  return (
    <div className={`cd-page-header${modifiers}`}>
      <div ref={text} className="cd-page-header__text" style={subtitleWidth === undefined ? undefined : { flexBasis: subtitleWidth }}>
        <Skeleton shape="line" text="page-title" width={180} className="cd-page-header__title" anchor="page-title" />
        {Math.max(wide, phone) > 0 ? (
          <div ref={subtitle === undefined ? undefined : subtitleBox} className="cd-page-header__subtitle">
            {Array.from({ length: Math.max(wide, phone) }, (_, i) => (
              <Skeleton
                key={i}
                shape="line"
                text="body"
                width={i === 0 ? '100%' : '75%'}
                className={`${i >= wide ? 'cd-page-header__phone-line' : ''} ${i >= phone ? 'cd-page-header__wide-line' : ''}`}
              />
            ))}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="cd-page-header__actions">
          {actions === true ? <Skeleton shape="block" width={140} height="var(--size-control)" anchor="page-actions" /> : actions}
        </div>
      ) : null}
    </div>
  );
}
