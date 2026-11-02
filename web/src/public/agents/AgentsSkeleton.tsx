import { useMemo, useRef, useState, type RefObject } from 'react';

import { ConceptFooter, PublicBrandHeaderSkeleton, Skeleton, SkeletonCard, type CopyLanguage } from '../../ds/index.ts';
import { useTextBox, useTextLines } from '../../lib/useTextLines.ts';
import { AGENTS_COPY, DEMO_TASK_COPY, DEMO_TASKS } from './copy.ts';

import './AgentCardPage.css';

/** The fresh Desk's capabilities, measured only, until the kernel's Agent Card is read. */
const CAN_DO: Record<CopyLanguage, readonly string[]> = {
  en: ['Get a quote from the price list', 'Find open times and book a visit', 'Pay the service call deposit within a signed limit', 'Ask Mike for a callback'],
  es: ['Pedir un presupuesto con la lista de precios', 'Ver horarios libres y reservar una visita', 'Pagar el depósito de la visita dentro de un límite firmado', 'Pedir que Mike devuelva la llamada'],
};

/** A reference row's known words in the real type, at this row's width and in this browser's fonts. */
function ReferenceRow({ words, text }: { words: string; text: 'body' | 'meta' }) {
  const row = useRef<HTMLDivElement>(null);
  const lines = useTextLines(row, { parts: [words], className: `cd-type-${text}` }, 1);
  return (
    <div ref={row}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === lines - 1 ? '70%' : '100%'} />
      ))}
    </div>
  );
}

/** Shapes for one reference card, using the real cards' title, body spacing and measured row heights. */
function ReferenceCard({ rows, text, anchor }: { rows: readonly string[]; text: 'body' | 'meta'; anchor: string }) {
  return (
    <SkeletonCard padding={16} anchor={anchor}>
      <Skeleton shape="line" text="section" width="65%" />
      <div className="cd-agents-card__body">
        <div className="cd-agents-page__list">
          {rows.map((words, i) => (
            <ReferenceRow key={i} words={words} text={text} />
          ))}
        </div>
      </div>
    </SkeletonCard>
  );
}

/** A task chip as wide as its words, and as tall as the lines they take in the row: a long one wraps in a narrow row. */
function TaskChip({ row, label, anchor }: { row: RefObject<HTMLDivElement | null>; label: string; anchor?: string }) {
  const className = 'cd-chip cd-type-pill';
  const { height } = useTextBox(row, { parts: [label], className }, 1);
  return <Skeleton shape="block" measure={{ label, className }} height={height ?? 'var(--space-28)'} radius="full" anchor={anchor} />;
}

/**
 * The fresh copy's task chips as shapes, in their row: the page's skeleton draws them, and the send
 * panel holds their place with them until the Desk's set is read (`loading`). The row is kept as
 * state, so the chips measure once it is in the page: their own effects run before its ref is set.
 */
export function TaskChipShapes({ language, loading = false }: { language: CopyLanguage; loading?: boolean }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const row = useMemo(() => ({ current: element }), [element]);
  return (
    <div ref={setElement} className="cd-suggestion-chips" aria-hidden={loading || undefined} data-loading={loading ? 'task-chips' : undefined}>
      {DEMO_TASKS.map((task, i) => (
        <TaskChip key={task} row={row} label={DEMO_TASK_COPY[language].rivera[task]} anchor={loading ? undefined : `task-chip-${i}`} />
      ))}
    </div>
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
            <Skeleton shape="line" text="page-title" width="45%" className="cd-agents-skeleton__phone-line" />
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
              <TaskChipShapes language={language} />
            </div>
          </SkeletonCard>
          <ReferenceCard rows={CAN_DO[language]} text="body" anchor="can-do-card" />
          <ReferenceCard
            rows={AGENTS_COPY[language].proveLines}
            text="meta"
            anchor="prove-card"
          />
          <SkeletonCard padding={16} anchor="connect-card">
            <Skeleton shape="line" text="section" width="55%" />
            <div className="cd-agents-card__lead">
              <Skeleton shape="line" text="meta" />
              <Skeleton shape="line" text="meta" className="cd-agents-skeleton__phone-line" />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
            </div>
            <div className="cd-agents-card__body">
              <Skeleton shape="block" height="var(--cd-agents-skeleton-address)" />
              <div className="cd-agents-page__list">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i}>
                    <Skeleton shape="line" text="meta" width="85%" />
                    {i < 2 ? <Skeleton shape="line" text="meta" width="60%" className="cd-agents-skeleton__phone-line" /> : null}
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
              <Skeleton shape="line" text="meta" />
              <Skeleton shape="line" text="meta" width="70%" className="cd-agents-skeleton__phone-line" />
              {language === 'es' ? <Skeleton shape="line" text="meta" width="60%" className="cd-agents-skeleton__phone-line" /> : null}
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
