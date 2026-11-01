import { Skeleton } from '../Skeleton/Skeleton.tsx';

import './PageHeader.css';

export interface PageHeaderSkeletonProps {
  subtitleLines?: number | { wide: number; phone: number };
  actions?: boolean;
  actionsBelowOnPhone?: boolean;
  hideSubtitleOnPhone?: boolean;
}

/** PageHeader's own line boxes and responsive action placement, without words. */
export function PageHeaderSkeleton({
  subtitleLines = 1,
  actions = false,
  actionsBelowOnPhone = false,
  hideSubtitleOnPhone = false,
}: PageHeaderSkeletonProps) {
  const wide = typeof subtitleLines === 'number' ? subtitleLines : subtitleLines.wide;
  const phone = typeof subtitleLines === 'number' ? subtitleLines : subtitleLines.phone;
  const modifiers = `${actionsBelowOnPhone ? ' cd-page-header--actions-below' : ''}${hideSubtitleOnPhone ? ' cd-page-header--no-phone-subtitle' : ''}`;
  return (
    <div className={`cd-page-header${modifiers}`}>
      <div className="cd-page-header__text">
        <Skeleton shape="line" text="page-title" width={180} className="cd-page-header__title" anchor="page-title" />
        {Math.max(wide, phone) > 0 ? (
          <div className="cd-page-header__subtitle">
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
          <Skeleton shape="block" width={140} height="var(--size-control)" anchor="page-actions" />
        </div>
      ) : null}
    </div>
  );
}
