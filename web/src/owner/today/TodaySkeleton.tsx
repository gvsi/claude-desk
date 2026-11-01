import { Skeleton, SkeletonCard } from '../../ds/index.ts';
import { publicLink } from '../customerLink.ts';

import './Today.css';

const BUTTON = 'cd-button cd-button--secondary cd-button--inline cd-type-control';

/** Line boxes use Today's responsive layout; widths suggest text without drawing any words. */
function Lines({ count, text = 'meta' }: { count: number | { wide: number; phone: number }; text?: 'meta' | 'body' | 'summary' }) {
  const wide = typeof count === 'number' ? count : count.wide;
  const phone = typeof count === 'number' ? count : count.phone;
  return (
    <>
      {Array.from({ length: Math.max(wide, phone) }, (_, i) => (
        <Skeleton
          key={i}
          shape="line"
          text={text}
          width={i === Math.max(wide, phone) - 1 ? '75%' : '100%'}
          className={`${i >= wide ? 'cd-today-skeleton__phone-line' : ''} ${i >= phone ? 'cd-today-skeleton__wide-line' : ''}`}
        />
      ))}
    </>
  );
}

function SectionTitle({ anchor, caption = false }: { anchor: string; caption?: boolean }) {
  return (
    <div className="cd-section-header">
      <div className="cd-section-header__title">
        <Skeleton shape="line" text="section" width={135} anchor={anchor} />
      </div>
      {caption ? <Skeleton shape="line" text="caption" width={145} /> : null}
    </div>
  );
}

/** The first view of a fresh copy: four things to try, one held request and the recorded night. */
export function TodaySkeleton() {
  return (
    <div className="cd-today cd-today--skeleton">
      <div className="cd-today__main">
        <div className="cd-today__greeting">
          <div className="cd-greeting">
            <div className="cd-greeting__text">
              <Skeleton shape="line" text="greeting" width="100%" anchor="greeting" />
              <Skeleton shape="line" text="body" width="80%" className="cd-today-skeleton__presence" />
            </div>
            <Skeleton
              shape="block"
              className="cd-today-skeleton__link"
              radius="full"
              measure={{
                label: publicLink('rivera-plumbing-abc123'),
                className: 'cd-greeting__link cd-type-meta',
                tagName: 'span',
                suffix: { className: 'cd-greeting__copy', width: 'calc(var(--size-control) - var(--space-6))' },
              }}
              height="var(--size-control)"
              anchor="link-pill"
            />
          </div>
        </div>
        <div className="cd-things">
          <div className="cd-things__head">
            <Skeleton shape="line" text="section" width={85} anchor="things-title" />
            <div className="cd-things__caption">
              <Lines count={1} />
            </div>
            <div className="cd-things__hide">
              <Skeleton shape="block" measure={{ label: 'Hide this list', className: 'cd-button cd-button--ghost cd-button--inline cd-type-control' }} height="var(--size-control)" anchor="things-hide" />
            </div>
          </div>
          <SkeletonCard padding={16} anchor="things-card">
            <div className="cd-things__list">
              {['Open your public page', 'Show me ideas', 'Open the request', 'Start a Desk'].map((label, i) => (
                <div key={i} className={`cd-things__item cd-today-skeleton__thing-${i}`}>
                  <Skeleton shape="block" width="var(--size-control)" height="var(--size-control)" anchor={`thing-tile-${i}`} />
                  <div className="cd-things__text">
                    <Skeleton shape="line" text="control" width="90%" />
                    <div className="cd-things__detail">
                      <Lines count={{ wide: i === 1 || i === 2 ? 3 : 2, phone: i === 1 || i === 2 ? 3 : 2 }} />
                    </div>
                  </div>
                  <div className="cd-things__action">
                    <Skeleton shape="block" measure={{ label, className: BUTTON, tagName: i === 0 || i === 3 ? 'a' : 'button' }} height="var(--size-control)" anchor={`thing-action-${i}`} />
                  </div>
                </div>
              ))}
            </div>
          </SkeletonCard>
          <div className="cd-things__vision">
            <Lines count={1} />
          </div>
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="needs-title" />
          <SkeletonCard anchor="held-card">
            <div className="cd-approval-card__top">
              <Skeleton shape="line" text="caption" width="80%" />
            </div>
            <div className="cd-approval-card__reason">
              <Lines count={{ wide: 2, phone: 3 }} text="summary" />
            </div>
            <div className="cd-approval-card__context">
              <Lines count={2} />
            </div>
            <div className="cd-approval-card__held-by">
              <Skeleton shape="block" width={16} height={16} />
              <div className="cd-today-skeleton__rule">
                <Lines count={{ wide: 1, phone: 2 }} />
              </div>
            </div>
            <div className="cd-approval-card__answers">
              <div className="cd-approval-card__row">
                <Skeleton shape="block" width="46%" height="var(--size-control-main)" className="cd-today-skeleton__answer" />
                <Skeleton shape="block" width="46%" height="var(--size-control-main)" className="cd-today-skeleton__answer" />
              </div>
            </div>
          </SkeletonCard>
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="live-title" caption />
          <div className="cd-live">
            <div className="cd-conversation-item" data-skeleton-anchor="live-row">
              <div className="cd-conversation-item__top">
                <Skeleton shape="line" text="control" width="55%" />
                <Skeleton shape="line" text="caption" width="20%" />
              </div>
            </div>
          </div>
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="since-title" />
          <SkeletonCard anchor="since-card">
            <div className="cd-briefing">
              {['booking', 'answer'].map((kind) => (
                <div key={kind} className="cd-briefing__item">
                  <div className="cd-briefing-row">
                    <Skeleton shape="line" text="caption" width={86} />
                    <span className="cd-briefing-row__kind cd-type-meta">
                      <span className="cd-status-label">
                        <Skeleton shape="circle" size={6} />
                        <Skeleton shape="line" text="meta" width={58} />
                      </span>
                    </span>
                    <div className="cd-briefing-row__words">
                      {kind === 'booking' ? (
                        <>
                          <Skeleton shape="line" text="meta" />
                          <div>
                            <Lines count={2} />
                          </div>
                        </>
                      ) : (
                        <Lines count={1} />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SkeletonCard>
        </div>
      </div>
      <div className="cd-today-aside">
        <SkeletonCard padding={16} anchor="public-card">
          <div className="cd-today-aside__public">
            <Skeleton shape="line" text="section" width={130} />
            <Skeleton shape="line" text="meta" width="65%" />
            <div className="cd-today-aside__text">
              <Lines count={2} />
            </div>
            <div className="cd-today-aside__action">
              <Skeleton shape="block" measure={{ label: 'Chat as a customer', className: BUTTON, tagName: 'a' }} height="var(--size-control)" anchor="public-page-action" />
            </div>
          </div>
        </SkeletonCard>
        <Skeleton shape="block" measure={{ label: 'Demo inbox', className: BUTTON, contentClassName: 'cd-demo-inbox-sheet__button', suffix: { label: '1', className: 'cd-count-pill cd-type-count' } }} height="var(--size-control)" anchor="inbox" />
        <SkeletonCard padding={16}>
          <div className="cd-week">
            <div className="cd-week__head">
              <Skeleton shape="line" text="section" width={110} anchor="week-title" />
            </div>
            <div className="cd-week__part">
              <Skeleton shape="line" text="figure" width="45%" />
              <Skeleton shape="line" text="meta" width="70%" />
              <div className="cd-week__bars">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="cd-week__day">
                    <div className="cd-week__bar-room">
                      <Skeleton
                        shape="block"
                        width="var(--space-24)"
                        height={i === 6 ? 'calc(var(--space-40) + var(--space-16))' : 'var(--space-2)'}
                        anchor={`week-bar-${i}`}
                      />
                    </div>
                    <Skeleton shape="line" text="caption" width="50%" />
                  </div>
                ))}
              </div>
            </div>
            <div className="cd-week__part">
              <Skeleton shape="line" text="control" width="70%" />
              <Skeleton shape="block" height="var(--space-6)" />
              <Skeleton shape="line" text="meta" />
            </div>
            <div className="cd-week__part">
              <Skeleton shape="line" text="control" width="70%" />
              <Skeleton shape="line" text="meta" width="65%" />
              <Skeleton shape="line" text="meta" width="30%" />
            </div>
          </div>
        </SkeletonCard>
      </div>
    </div>
  );
}
