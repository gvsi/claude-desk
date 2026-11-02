import { Card, PageHeaderSkeleton, Skeleton } from '../../ds/index.ts';

import '../settings/Settings.css';
import './Profile.css';

/** The business details and header colour card while the Desk is read. */
export function ProfileSkeleton() {
  return (
    <>
      <PageHeaderSkeleton subtitleLines={1} />
      <div className="cd-profile">
        <div className="cd-settings__section">
          <Skeleton shape="line" text="section" width="25%" />
          <Card padding={0}>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="cd-detail-list__row">
                <Skeleton shape="line" text="meta" width="30%" />
                <Skeleton shape="line" text="body" width="60%" />
              </div>
            ))}
          </Card>
        </div>
        <Card>
          <Skeleton shape="line" text="section" width="30%" />
          <Skeleton shape="line" text="meta" width="80%" />
          <Skeleton shape="block" height="var(--size-control-main)" />
          <Skeleton shape="block" height="var(--size-brand-header)" />
        </Card>
      </div>
    </>
  );
}
