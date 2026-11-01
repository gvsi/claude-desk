import { Skeleton } from '../Skeleton/Skeleton.tsx';

import '../Button/Button.css';
import './ReviewerBar.css';

/** The demo bar's one line, two on a phone, and its Start over control. */
export function ReviewerBarSkeleton() {
  return (
    <div className="cd-reviewer-bar" data-skeleton-anchor="reviewer-bar">
      <div className="cd-reviewer-bar__text">
        <Skeleton shape="line" text="meta" width="min(100%, 430px)" />
        <Skeleton shape="line" text="meta" width="75%" className="cd-reviewer-bar__phone-line" />
      </div>
      <Skeleton shape="block" measure={{ label: 'Start over', className: 'cd-button cd-button--ghost cd-button--inline cd-type-control' }} height="var(--size-control)" />
    </div>
  );
}
