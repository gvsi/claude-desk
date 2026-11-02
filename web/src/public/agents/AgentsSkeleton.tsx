import { useMemo, useRef, useState, type RefObject } from 'react';

import { ConceptFooter, PublicBrandHeaderSkeleton, Skeleton, SkeletonCard, type CopyLanguage } from '../../ds/index.ts';
import { useTextBox, useTextLines } from '../../lib/useTextLines.ts';
import { AGENTS_COPY, DEMO_TASK_COPY, DEMO_TASKS, DEMO_TASK_ROWS, type DemoTask } from './copy.ts';

import './AgentCardPage.css';

/**
 * The fresh copy's "What agents can do here": one row for each ability the Turner seed offers an
 * agent, in the order the kernel's Agent Card lists them, measured only until the card is read.
 */
const CAN_DO: Readonly<Record<CopyLanguage, readonly string[]>> = {
  en: [
    'Get a quote from the price list',
    'Find open times',
    'Book a visit',
    'Get a payment link for a quote',
    'Pay for a quote within a signed limit',
    'Leave contact details',
    'Ask for a callback',
    'Verify a customer with a code sent to their contact on record',
    "Receive a verified customer's own documents",
    "List a verified customer's own charges",
  ],
  es: [
    'Pedir una cotización de la lista de precios',
    'Buscar horarios libres',
    'Reservar una visita',
    'Pedir un enlace de pago para una cotización',
    'Pagar una cotización dentro de un límite firmado',
    'Dejar datos de contacto',
    'Pedir que te devuelvan la llamada',
    'Verificar a un cliente con un código enviado a su contacto registrado',
    'Recibir los documentos propios de un cliente verificado',
    'Ver los cargos propios de un cliente verificado',
  ],
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

/**
 * Shapes for "What agents can do here", in the real card's rows: each ability's words in the lines
 * they take at the row's width, then its outcome's line under them, each row under a hairline.
 */
function CanDoCard({ rows }: { rows: readonly string[] }) {
  return (
    <SkeletonCard padding={16} anchor="can-do-card">
      <Skeleton shape="line" text="section" width="65%" />
      <div className="cd-agents-card__body">
        <div className="cd-agents-page__abilities">
          {rows.map((words, i) => (
            <div key={i} className="cd-agents-page__ability">
              <ReferenceRow words={words} text="body" />
              <Skeleton shape="line" text="meta" width={72} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonCard>
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

/** One row of task chips as shapes; the row is kept as state, so its chips measure once it is in the page. */
function TaskChipRow({ language, tasks, loading }: { language: CopyLanguage; tasks: readonly DemoTask[]; loading: boolean }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const row = useMemo(() => ({ current: element }), [element]);
  return (
    <div ref={setElement} className="cd-suggestion-chips" aria-hidden={loading || undefined} data-loading={loading ? 'task-chips' : undefined}>
      {tasks.map((task) => (
        <TaskChip key={task} row={row} label={DEMO_TASK_COPY[language].rivera[task]} anchor={loading ? undefined : `task-chip-${DEMO_TASKS.indexOf(task)}`} />
      ))}
    </div>
  );
}

/**
 * The fresh copy's task chips as shapes, in board 03's rows (tasks without money, then payments):
 * the page's skeleton draws them, and the send panel holds their place with them until the Desk's
 * set is read (`loading`).
 */
export function TaskChipShapes({ language, loading = false }: { language: CopyLanguage; loading?: boolean }) {
  return (
    <div className="cd-agents-card__tasks">
      {DEMO_TASK_ROWS.map((tasks) => <TaskChipRow key={tasks[0]} language={language} tasks={tasks} loading={loading} />)}
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
          <CanDoCard rows={CAN_DO[language]} />
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
