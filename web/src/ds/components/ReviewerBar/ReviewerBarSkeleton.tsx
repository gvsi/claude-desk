import { Skeleton } from '../Skeleton/Skeleton.tsx';

import './ReviewerBar.css';

/** The demo bar's one line, two on a phone, and its Start over control. */
export function ReviewerBarSkeleton() {
  return (
    <div className="cd-reviewer-bar" data-skeleton-anchor="reviewer-bar">
      <div className="cd-reviewer-bar__text">
        <Skeleton shape="line" text="meta" width="min(100%, 430px)" />
        <Skeleton shape="line" text="meta" width="75%" className="cd-reviewer-bar__phone-line" />
      </div>
      <Skeleton shape="block" width={86} height="var(--size-control)" />
    </div>
  );
}
