import { Skeleton } from '../Skeleton/Skeleton.tsx';

import './PublicShell.css';

/** The fresh copy's brand header before its name, colours and hours have been read. */
export function PublicBrandHeaderSkeleton({ hours }: { hours: boolean }) {
  return (
    <div className="cd-public-brand cd-public-brand--skeleton" data-skeleton-anchor="brand-header">
      <div className={`cd-public-shell__brand${hours ? ' cd-public-shell__brand--open-status' : ''}`}>
        <Skeleton shape="block" width="var(--size-control-main)" height="var(--size-control-main)" radius="card" />
        <div className="cd-public-shell__brand-text">
          <Skeleton shape="line" text="brand-name" width={160} />
          <Skeleton shape="line" text="meta" width={80} />
        </div>
        {hours ? (
          <div className="cd-public-shell__open-status">
            <Skeleton shape="line" text="meta" width={170} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
