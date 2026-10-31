import { ConceptFooter, PublicBrandHeaderSkeleton, Skeleton, SkeletonCard } from '../../ds/index.ts';

import './AgentCardPage.css';

/** Shapes for one reference card, using the real cards' title and body spacing. */
function ReferenceCard({ rows, text, anchor }: { rows: readonly number[]; text: 'body' | 'meta'; anchor: string }) {
  return (
    <SkeletonCard padding={16} anchor={anchor}>
      <Skeleton shape="line" text="section" width="65%" />
      <div className="cd-agents-card__body">
        <div className="cd-agents-page__list">
          {rows.map((phoneLines, i) => (
            <div key={i}>
              <Skeleton shape="line" text={text} width={i === rows.length - 1 ? '70%' : '100%'} />
              {Array.from({ length: phoneLines - 1 }, (_, line) => (
                <Skeleton key={line} shape="line" text={text} width="70%" className="cd-agents-skeleton__phone-line" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </SkeletonCard>
  );
}

/** The fresh copy's agents page. No names, disclosure, limits or task labels are stated. */
export function AgentsSkeleton() {
  return (
    <div className="cd-agents-page cd-agents-page--skeleton">
      <PublicBrandHeaderSkeleton hours={false} />
      <div className="cd-agents-page__main">
        <Skeleton shape="line" text="body" width={110} anchor="back-link" />
        <div className="cd-agents-page__head">
          <div data-skeleton-anchor="page-title">
            <Skeleton shape="line" text="page-title" width="70%" />
          </div>
          <Skeleton shape="line" text="meta" width="70%" anchor="disclosure" />
        </div>
        <div className="cd-agents-page__cards">
          <SkeletonCard padding={16} anchor="send-card">
            <Skeleton shape="line" text="section" width={110} />
            <div className="cd-agents-card__lead">
              <Skeleton shape="line" text="meta" />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
            </div>
            <div className="cd-agents-card__body">
              <div className="cd-signed-limit">
                <div className="cd-signed-limit__terms">
                  {[64, 64, 68].map((width, i) => (
                    <div key={i}>
                      <Skeleton shape="line" text="caption" width={width} />
                      <Skeleton shape="line" text="body" width="70%" />
                    </div>
                  ))}
                </div>
                <Skeleton shape="line" text="caption" width={190} className="cd-signed-limit__source" />
              </div>
              <div className="cd-suggestion-chips">
                {[143, 263, 183].map((width) => <Skeleton key={width} shape="block" width={width} height="var(--space-28)" radius="full" />)}
              </div>
            </div>
          </SkeletonCard>
          <ReferenceCard rows={[1, 1, 1, 1]} text="body" anchor="can-do-card" />
          <ReferenceCard rows={[2, 2, 2, 1, 1]} text="meta" anchor="prove-card" />
          <SkeletonCard padding={16} anchor="connect-card">
            <Skeleton shape="line" text="section" width="55%" />
            <div className="cd-agents-card__lead">
              <Skeleton shape="line" text="meta" />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
            </div>
            <div className="cd-agents-card__body">
              <Skeleton shape="block" height="var(--cd-agents-skeleton-address)" />
              <div className="cd-agents-page__list">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i}>
                    <Skeleton shape="line" text="meta" width="85%" />
                    {i === 0 ? <Skeleton shape="line" text="meta" width="60%" className="cd-agents-skeleton__phone-line" /> : null}
                  </div>
                ))}
              </div>
              <Skeleton shape="line" text="control" width="30%" className="cd-agents-page__label" />
              <Skeleton shape="block" height="var(--cd-agents-skeleton-code)" />
            </div>
          </SkeletonCard>
          <SkeletonCard padding={16} anchor="key-card">
            <Skeleton shape="line" text="section" width="40%" />
            <div className="cd-agents-card__lead">
              <Skeleton shape="line" text="meta" />
              <Skeleton shape="line" text="meta" className="cd-agents-skeleton__phone-line" />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
            </div>
            <div className="cd-agents-card__body">
              <Skeleton shape="block" width={140} height="var(--size-control)" />
            </div>
          </SkeletonCard>
        </div>
        <div className="cd-agents-skeleton__footer" data-skeleton-anchor="agents-footer"><ConceptFooter /></div>
      </div>
    </div>
  );
}
