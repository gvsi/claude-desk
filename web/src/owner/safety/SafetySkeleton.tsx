import { useRef } from 'react';

import { chainLine, entriesLabel, PageHeaderSkeleton, Skeleton, SkeletonCard, type SkeletonText } from '../../ds/index.ts';
import { useTextBox, useTextLines } from '../../lib/useTextLines.ts';
import { CATEGORY_LABELS, NOT_SORTED, REPLAYED_LABEL, REPLY_STOPPED_LABEL, SAFETY_SUBTITLE, heldForYou, originCopy, turnedDownHeadline } from './copy.ts';

import './Safety.css';

/** The fresh seed's stopped draft; these words are measured only, never put on the page. */
const REASON = "Claude's reply put a price in its own words instead of a checked card, so it wasn't shown. The visitor was told you'll answer.";
const SUMMARY = 'The visitor asked for a discount. Claude’s draft stated the discount in its own words, so the Desk stopped the reply.';

function Lines({ words, className, text, anchor }: { words: string; className: string; text: SkeletonText; anchor?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const count = useTextLines(box, { parts: [words], className }, 1);
  return (
    <div ref={box} className={className} style={{ width: '100%' }} data-skeleton-anchor={anchor}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i ? '70%' : '100%'} />
      ))}
    </div>
  );
}

/**
 * A fresh copy's first stopped attempt is a reply Claude has summarised, so its row's label comes
 * first: as many lines as its words take beside its status dot.
 */
function RowLabel() {
  const box = useRef<HTMLSpanElement>(null);
  const className = 'cd-attempt-row__why cd-type-meta';
  const count = useTextLines(box, { parts: [{ text: '', className: 'cd-safety-skeleton__dot-room' }, REPLY_STOPPED_LABEL], className }, 1);
  return (
    <span ref={box} className={className}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text="meta" width={i === count - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}

function Control({
  label,
  className,
  selected = false,
  icon = false,
  anchor,
}: {
  label: string;
  className: string;
  selected?: boolean;
  icon?: boolean;
  anchor?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { height } = useTextBox(box, { parts: [label], className }, 1);
  return (
    <div ref={box} className="cd-safety-skeleton__control">
      <Skeleton
        shape="block"
        height={height}
        anchor={anchor}
        measure={{
          label,
          className,
          ...(selected || icon
            ? {
                suffix: {
                  className: 'cd-safety-skeleton__suffix',
                  width: selected ? 'var(--space-14)' : 'var(--space-16)',
                },
              }
            : {}),
        }}
      />
    </div>
  );
}

function Bar() {
  return (
    <div className="cd-safety__bar">
      <div className="cd-safety__chain">
        <div className="cd-chain-status" data-skeleton-anchor="safety-chain">
          <div className="cd-chain-status__line cd-type-body">
            <Skeleton shape="circle" size={6} />
            <Skeleton
              shape="block"
              height="1lh"
              radius="full"
              measure={{
                label: chainLine(true, null).line,
                className: 'cd-type-body',
                tagName: 'span',
              }}
            />
          </div>
          <Skeleton
            shape="block"
            height="1lh"
            className="cd-chain-status__count cd-type-caption"
            radius="full"
            measure={{
              label: entriesLabel(40),
              className: 'cd-type-caption',
              tagName: 'span',
            }}
          />
          <Skeleton
            shape="block"
            height="1lh"
            className="cd-chain-status__key cd-type-caption"
            radius="full"
            measure={{
              label: 'Signed with a development key',
              className: 'cd-type-caption',
              tagName: 'span',
            }}
          />
        </div>
      </div>
      <div className="cd-segmented" data-skeleton-anchor="safety-view">
        {['Stopped', 'Every entry'].map((label) => (
          <Control key={label} label={label} className="cd-segmented__option cd-type-meta" />
        ))}
      </div>
    </div>
  );
}

function Detail() {
  return (
    <div className="cd-safety__opened">
      <SkeletonCard anchor="safety-detail">
        <div className="cd-attempt">
          <div className="cd-attempt__status cd-type-meta" data-skeleton-anchor="safety-detail-status">
            <Skeleton shape="line" text="meta" width="70%" />
          </div>
          <div className="cd-attempt__what">
            <Lines words={REASON} className="cd-attempt__reason cd-type-summary" text="summary" anchor="safety-detail-title" />
            <Lines words="This reply was never shown." className="cd-attempt__claim cd-type-body" text="body" anchor="safety-claim" />
            <Lines words={originCopy('kernel')} className="cd-attempt__origin cd-type-caption" text="caption" anchor="safety-origin" />
            <Lines words={REPLAYED_LABEL} className="cd-attempt__origin cd-type-caption" text="caption" anchor="safety-replayed" />
          </div>
          <div className="cd-attempt__part">
            <Skeleton shape="line" text="caption" width="70%" anchor="safety-summary-label" />
            <Lines words={SUMMARY} className="cd-attempt__summary cd-type-body" text="body" anchor="safety-summary" />
          </div>
          <div className="cd-attempt__part">
            {['See how it was stopped', 'Full trace'].map((label, i) => (
              <Control key={label} label={label} className="cd-attempt__toggle cd-type-control" icon anchor={`safety-toggle-${i}`} />
            ))}
          </div>
          <Skeleton shape="line" text="meta" width="60%" anchor="safety-conversation" />
        </div>
      </SkeletonCard>
    </div>
  );
}

/**
 * Safety's first view, in its own responsive layout, with its header added on a reload: its subtitle
 * in as many lines as its words take at the column's width in this browser's fonts. The header's
 * action is drawn as one request held for the owner, as on a fresh copy, since the count isn't read yet.
 */
export function SafetySkeleton({ withHeader }: { withHeader: boolean }) {
  return (
    <div className="cd-safety">
      {withHeader ? (
        <PageHeaderSkeleton
          subtitle={SAFETY_SUBTITLE}
          actions={
            <Skeleton
              shape="block"
              height="var(--size-control)"
              anchor="page-actions"
              measure={{
                label: heldForYou(1),
                className: 'cd-button cd-button--secondary cd-button--inline cd-type-control',
                contentClassName: 'cd-status-label',
                suffix: { className: 'cd-status-dot', width: 'var(--size-dot)' },
              }}
            />
          }
        />
      ) : null}
      <Lines words={turnedDownHeadline(0)} className="cd-safety__headline cd-type-summary" text="summary" anchor="safety-headline" />
      <Bar />
      <div className="cd-safety__split">
        <div className="cd-attempts">
          <div className="cd-attempts__filters" data-skeleton-anchor="safety-filters">
            {['All', ...CATEGORY_LABELS, NOT_SORTED].map((label, i) => (
              <Control key={label} label={label} className={`cd-chip cd-type-pill${i === 0 ? ' cd-chip--selected' : ''}`} selected={i === 0} />
            ))}
          </div>
          <div className="cd-attempts__list">
            <div className="cd-attempt-row" data-skeleton-anchor="safety-row-0">
              <div className="cd-attempt-row__grid">
                <Skeleton shape="line" text="meta" className="cd-attempt-row__time" width="80%" />
                <div className="cd-attempt-row__what">
                  <RowLabel />
                  <Skeleton shape="line" text="control" className="cd-attempt-row__title" />
                  <div className="cd-attempt-row__from">
                    <Skeleton shape="line" text="caption" width="90%" />
                  </div>
                </div>
                <div className="cd-attempt-row__stopped">
                  <div className="cd-checkpoint-meter">
                    <div className="cd-checkpoint-meter__segments">
                      {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} shape="circle" size={6} />
                      ))}
                    </div>
                    <Skeleton shape="line" text="caption" width="90%" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="cd-safety__beside">
          <Detail />
        </div>
      </div>
    </div>
  );
}
