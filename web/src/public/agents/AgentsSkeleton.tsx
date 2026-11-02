import { ConceptFooter, PublicBrandHeaderSkeleton, Skeleton, SkeletonCard, type CopyLanguage } from '../../ds/index.ts';
import { AGENTS_COPY, DEMO_TASK_COPY, DEMO_TASKS, DEMO_TASK_ROWS } from './copy.ts';

import './AgentCardPage.css';

/**
 * The fresh copy's "What agents can do here": one row for each ability the Turner seed offers an
 * agent, in the order the kernel's Agent Card lists them, each with the lines it takes on a phone.
 * On wider screens every row is one line.
 */
const CAN_DO_ROWS: Readonly<Record<CopyLanguage, readonly number[]>> = {
  en: [1, 1, 1, 1, 1, 1, 1, 2, 1, 1],
  es: [1, 1, 1, 1, 2, 1, 1, 2, 2, 1],
};

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
export function AgentsSkeleton({ language }: { language: CopyLanguage }) {
  return (
    <div className="cd-agents-page cd-agents-page--skeleton" lang={language}>
      <PublicBrandHeaderSkeleton hours={false} />
      <div className="cd-agents-page__main">
        <Skeleton shape="line" text="body" width={110} anchor="back-link" />
        <div className="cd-agents-page__head">
          <div data-skeleton-anchor="page-title">
            <Skeleton shape="line" text="page-title" width="70%" />
            {language === 'es' ? <Skeleton shape="line" text="page-title" width="45%" className="cd-agents-skeleton__phone-line" /> : null}
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
                <div className="cd-signed-limit__source">
                  <Skeleton shape="line" text="caption" width={language === 'es' ? 265 : 190} />
                  {language === 'es' ? <Skeleton shape="line" text="caption" width="60%" className="cd-agents-skeleton__phone-line" /> : null}
                </div>
              </div>
              <div className="cd-agents-card__tasks">
                {DEMO_TASK_ROWS.map((row) => (
                  <div key={row[0]} className="cd-suggestion-chips">
                    {row.map((task) => <Skeleton key={task} shape="block" measure={{ label: DEMO_TASK_COPY[language].rivera[task], className: 'cd-chip cd-type-pill' }} height="var(--space-28)" radius="full" anchor={`task-chip-${DEMO_TASKS.indexOf(task)}`} />)}
                  </div>
                ))}
              </div>
            </div>
          </SkeletonCard>
          <ReferenceCard rows={CAN_DO_ROWS[language]} text="body" anchor="can-do-card" />
          <ReferenceCard rows={language === 'es' ? [2, 3, 2, 1, 1] : [2, 2, 2, 1, 1]} text="meta" anchor="prove-card" />
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
                    {i === 0 || (language === 'es' && i === 1) ? <Skeleton shape="line" text="meta" width="60%" className="cd-agents-skeleton__phone-line" /> : null}
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
              <Skeleton shape="line" text="meta" className={language === 'es' ? undefined : 'cd-agents-skeleton__phone-line'} />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
            </div>
            <div className="cd-agents-card__body">
              <Skeleton shape="block" measure={{ label: AGENTS_COPY[language].getDemoKey, className: 'cd-button cd-button--secondary cd-button--inline cd-type-control' }} height="var(--size-control)" anchor="key-action" />
            </div>
          </SkeletonCard>
        </div>
        <div className="cd-agents-skeleton__footer" data-skeleton-anchor="agents-footer"><ConceptFooter skeleton /></div>
      </div>
    </div>
  );
}
