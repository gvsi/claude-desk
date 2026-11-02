import { Card, PageHeaderSkeleton, Skeleton } from '../../ds/index.ts';

import './Knowledge.css';

function ListShape({ rows, tiles = false }: { rows: number; tiles?: boolean }) {
  return (
    <div className="cd-knowledge-list">
      <Skeleton shape="line" text="section" width="55%" />
      <Card padding={0}>
        {Array.from({ length: rows }, (_, i) => (
          <div className="cd-knowledge-list__row" key={i}>
            {tiles ? <Skeleton shape="block" width="var(--size-nav-row)" height="var(--size-nav-row)" /> : null}
            <div className="cd-knowledge-list__words">
              <Skeleton shape="line" text="body" width="70%" />
              <Skeleton shape="line" text="meta" width="85%" />
            </div>
            <Skeleton shape="block" width="var(--space-40)" height="var(--space-20)" radius="full" />
          </div>
        ))}
      </Card>
    </div>
  );
}

/** The same source-list shapes before and after the owner frame opens. */
export function KnowledgeListSkeleton() {
  return <ListShape rows={6} tiles />;
}

/** The source list, Add something column and static previews in the page’s responsive order. */
export function KnowledgeSkeleton({ showSampleQuestions = true }: { showSampleQuestions?: boolean } = {}) {
  return (
    <>
      <PageHeaderSkeleton subtitleLines={1} />
      <div className="cd-knowledge">
        <div className="cd-knowledge__known">
          <KnowledgeListSkeleton />
        </div>
        <div className="cd-knowledge__add cd-knowledge-add__form">
          <Skeleton shape="line" text="section" width="55%" />
          <Skeleton shape="line" text="control" width="35%" />
          <Skeleton shape="block" height="calc(var(--space-32) * 3)" />
          <Skeleton shape="line" text="meta" />
          <Skeleton shape="block" height="var(--size-control-main)" />
          <Skeleton shape="line" text="caption" />
          <Skeleton shape="line" text="control" width="35%" />
          <Skeleton shape="block" height="var(--size-control-main)" />
          <Skeleton shape="block" height="var(--size-control-main)" width="65%" />
          <Skeleton shape="line" text="caption" />
        </div>
        <div className="cd-knowledge__previews">
          {showSampleQuestions ? <ListShape rows={3} /> : null}
          <ListShape rows={3} />
        </div>
      </div>
    </>
  );
}
