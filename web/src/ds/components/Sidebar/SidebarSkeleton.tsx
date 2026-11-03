import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { AppShellOnly } from '../AppShell/AppShell.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';

import './Sidebar.css';
import '../Switch/Switch.css';

/** The fresh copy's sidebar, before its business and owner have been read. */
export function SidebarSkeleton({ rows, about, conceptFooter = false }: { rows: number; about: number; conceptFooter?: boolean }) {
  const row = (key: string, anchor?: string) => (
    <div key={key} className="cd-sidebar__row" data-skeleton-anchor={anchor}>
      <Skeleton shape="block" width={20} height={20} />
      <Skeleton shape="line" text="control" width="65%" />
    </div>
  );
  return (
    <div className="cd-sidebar">
      <div className="cd-sidebar__brand">
        <Skeleton shape="block" width={36} height={36} anchor="sidebar-mark" />
        <div className="cd-sidebar__skeleton-wordmark">
          <Skeleton shape="line" text="control" width={94} />
          <Skeleton shape="block" width={55} height={20} radius="full" />
        </div>
      </div>
      <div className="cd-sidebar__business" data-skeleton-anchor="business-row">
        <Skeleton shape="line" text="control" width="80%" />
      </div>
      <div className="cd-sidebar__middle">
        <div className="cd-sidebar__nav">{Array.from({ length: rows }, (_, i) => row(`page-${i}`, `page-row-${i}`))}</div>
        {about > 0 ? (
          <div className="cd-sidebar__about">
            <div className="cd-sidebar__about-title">
              <Skeleton shape="line" text="caption" width="75%" />
            </div>
            {Array.from({ length: about }, (_, i) => row(`about-${i}`))}
          </div>
        ) : null}
        {conceptFooter ? (
          <AppShellOnly layout="wide">
            <div className="cd-sidebar__concept-footer" data-skeleton-anchor="owner-footer" data-owner-footer>
              <ConceptFooter skeleton />
            </div>
          </AppShellOnly>
        ) : null}
      </div>
      <div className="cd-sidebar__footer">
        <div className="cd-switch">
          <div className="cd-switch__text">
            <Skeleton shape="line" text="control" width="70%" />
            <Skeleton shape="line" text="caption" />
          </div>
          <Skeleton shape="block" width={36} height={20} radius="full" />
        </div>
        <div className="cd-sidebar__owner">
          <Skeleton shape="circle" anchor="owner-avatar" />
          <div className="cd-sidebar__owner-text">
            <Skeleton shape="line" text="control" width="65%" />
            <Skeleton shape="line" text="caption" width="85%" />
          </div>
        </div>
      </div>
    </div>
  );
}
