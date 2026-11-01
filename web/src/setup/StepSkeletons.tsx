/**
 * Setup's steps as quiet shapes while their reads are out, each built from its own components'
 * classes so the step lands where the shapes were. They draw what a fresh copy's interview shows
 * (the seed's connectors, the draft, situations and tricks from the example answers), with the
 * line counts its words take at a laptop's width and a phone's. A skeleton draws no words.
 */
import type { ReactNode } from 'react';

import { PageHeaderSkeleton, Skeleton, SkeletonCard, SkeletonScreen, type SkeletonText } from '../ds/index.ts';
import { SETUP_COPY } from './copy.ts';

/**
 * Setup's column while the interview itself is read ("Opening your setup"): a step's header as
 * shapes, since every step opens with a `PageHeader`, a title over a line (two on a phone). The
 * step is drawn in it once read: a step whose own read is still out carries the shapes on at once
 * under its real header, so a reload never goes blank between the two.
 */
export function SetupOpening({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return (
    <SkeletonScreen loading={loading} status={SETUP_COPY.questions.loading} skeleton={<PageHeaderSkeleton subtitleLines={{ wide: 1, phone: 2 }} />}>
      {children}
    </SkeletonScreen>
  );
}

/** A secondary button inline in a row, as "Add" and "Connect" are drawn. */
const ROW_BUTTON = 'cd-button cd-button--secondary cd-button--inline cd-type-control';

/** How many lines some words take: the same at every width, or more on a phone, where they wrap. */
type LineCount = number | { wide: number; phone: number };

/**
 * Lines of one type style, the last one short (`last`, or `phoneLast` for a phone's). Where a phone
 * wraps the words onto more lines, the laptop's lines and the phone's are drawn apart, each shown
 * only at its own width.
 */
function Lines({ count, text = 'body', last = '70%', phoneLast = last }: { count: LineCount; text?: SkeletonText; last?: string; phoneLast?: string }) {
  const wide = typeof count === 'number' ? count : count.wide;
  const phone = typeof count === 'number' ? count : count.phone;
  const set = (n: number, only?: 'wide' | 'phone') =>
    Array.from({ length: n }, (_, i) => (
      <Skeleton
        key={`${only ?? 'all'}-${i}`}
        shape="line"
        text={text}
        width={i === n - 1 ? (only === 'phone' ? phoneLast : last) : '100%'}
        {...(only === undefined ? {} : { className: `cd-setup-skeleton__${only}-line` })}
      />
    ));
  return wide === phone ? <>{set(wide)}</> : <>{set(wide, 'wide')}{set(phone, 'phone')}</>;
}

/** One connector's row: where it stands ("On", "Always on") or its button ("Add"). */
interface ToolRowShape {
  /** The name's width, in px. */
  name: number;
  /** The line's width on a laptop, where it takes one line. */
  line: string;
  /** How many lines the line takes on a phone, and its last one's width there. */
  phone: number;
  phoneLast?: string;
  end: 'on' | 'always_on' | 'add';
}

/** A fresh Desk's built-in connectors, in the catalog's order: Quotes, Bookings, Leads and callbacks, Verification, Documents, Payments. */
const BUILT_IN: readonly ToolRowShape[] = [
  { name: 46, line: '35%', phone: 1, end: 'on' },
  { name: 57, line: '38%', phone: 1, end: 'on' },
  { name: 127, line: '55%', phone: 2, phoneLast: '15%', end: 'on' },
  { name: 71, line: '40%', phone: 1, end: 'always_on' },
  { name: 71, line: '75%', phone: 2, phoneLast: '40%', end: 'add' },
  { name: 61, line: '75%', phone: 2, phoneLast: '60%', end: 'add' },
];

/** The row's tile and its name over its line, as `ConnectorSummary` draws them. */
function ToolSummary({ name, line, phone, phoneLast, badge = false }: Omit<ToolRowShape, 'end'> & { badge?: boolean }) {
  return (
    <>
      <Skeleton shape="block" className="cd-connector-icon cd-connector-icon--section" />
      <span className="cd-connector-summary">
        <span className="cd-connector-summary__name cd-type-body">
          {badge ? (
            // The name and its badge ride the name's line as the real ones do, set on its middle, so
            // the line is as deep as the badge makes it.
            <>
              <Skeleton shape="block" width={name} height={12} radius="full" className="cd-setup-skeleton__inline" />{' '}
              <Skeleton shape="block" width={48} height="var(--space-20)" radius="full" className="cd-setup-skeleton__inline cd-setup-skeleton__badge" />
            </>
          ) : (
            <Skeleton shape="line" text="body" width={name} />
          )}
        </span>
        <span className="cd-connector-summary__description cd-type-meta">
          <Lines count={{ wide: 1, phone }} text="meta" last={line} phoneLast={phoneLast} />
        </span>
      </span>
    </>
  );
}

/** Where a built-in connector stands, or its button. */
function ToolEnd({ end }: { end: ToolRowShape['end'] }) {
  if (end === 'add') {
    return (
      <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
        <Skeleton shape="block" measure={{ label: 'Add', className: ROW_BUTTON }} height="var(--size-control)" />
      </span>
    );
  }
  return (
    <span className="cd-setup-tools__end cd-type-meta">
      <Skeleton shape="circle" size={6} />
      <Skeleton shape="line" text="meta" width={end === 'on' ? 17 : 57} />
    </span>
  );
}

/**
 * "What Claude can use" while the tools are read (`SetupToolsList`): "Built in" and "Connect your
 * own", each a card of rows, as a fresh Desk lists them: four connectors on or always on, two to
 * add, and Stripe to connect, with its Mock badge, its tool count and "Connect".
 */
export function ToolsListSkeleton() {
  return (
    <div className="cd-setup-tools">
      <SkeletonCard padding={16}>
        <Skeleton shape="line" text="control" width={56} className="cd-setup-tools__heading" />
        <ul className="cd-setup-tools__rows">
          {BUILT_IN.map((row, i) => (
            <li key={i} className="cd-setup-tools__row" data-skeleton-anchor={`tools-built-in-row-${i}`}>
              <ToolSummary {...row} />
              <ToolEnd end={row.end} />
            </li>
          ))}
        </ul>
      </SkeletonCard>
      <SkeletonCard padding={16}>
        <Skeleton shape="line" text="control" width={118} className="cd-setup-tools__heading" />
        <ul className="cd-setup-tools__rows">
          <li className="cd-setup-tools__row" data-skeleton-anchor="tools-external-row-0">
            <ToolSummary name={37} line="85%" phone={2} phoneLast="40%" badge />
            <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
              <Skeleton shape="line" text="meta" width={40} />
              <Skeleton shape="block" measure={{ label: 'Connect', className: ROW_BUTTON }} height="var(--size-control)" />
            </span>
          </li>
        </ul>
      </SkeletonCard>
    </div>
  );
}

/** One rule's row: what Claude does (its line's width on a laptop, and its lines on a phone) and who it's for. */
interface RuleRowShape {
  text: string;
  phone: number;
  phoneLast?: string;
  /** Who it's for, in px. */
  who: number;
}

/**
 * The draft a fresh copy's example answers make, by group: what Claude does on its own (the ask-first
 * preset's open rules, then quotes, weekday bookings, documents and the agents' deposit), what asks
 * you (Saturday bookings, payment links) and what it never does (refunds).
 */
const RULE_GROUPS: readonly { title: number; rows: readonly RuleRowShape[] }[] = [
  {
    title: 104,
    rows: [
      { text: '45%', phone: 1, who: 43 },
      { text: '55%', phone: 2, phoneLast: '25%', who: 43 },
      { text: '40%', phone: 1, who: 43 },
      { text: '85%', phone: 2, phoneLast: '60%', who: 43 },
      { text: '80%', phone: 2, phoneLast: '30%', who: 43 },
      { text: '85%', phone: 2, phoneLast: '60%', who: 43 },
      { text: '85%', phone: 2, phoneLast: '45%', who: 43 },
      { text: '50%', phone: 1, who: 43 },
      { text: '40%', phone: 1, who: 43 },
      { text: '55%', phone: 2, phoneLast: '50%', who: 161 },
      { text: '90%', phone: 3, phoneLast: '40%', who: 80 },
    ],
  },
  { title: 56, rows: [{ text: '38%', phone: 1, who: 43 }, { text: '35%', phone: 1, who: 43 }] },
  { title: 76, rows: [{ text: '42%', phone: 1, who: 43 }] },
];

/** The anchor each group's rows are named by, in `OutcomeGroups`' order. */
const GROUP_NAMES = ['auto', 'ask', 'never'] as const;

/** The always-on rules' lines on a phone, where the fourth wraps; each one line on a laptop. */
const ALWAYS_ON_LINES: readonly { width: string; phone: number; phoneLast?: string }[] = [
  { width: '25%', phone: 1 },
  { width: '42%', phone: 1 },
  { width: '45%', phone: 1 },
  { width: '58%', phone: 2, phoneLast: '20%' },
  { width: '48%', phone: 1 },
];

/**
 * "Your rules" while the draft is made (`DraftRules`): the payment limit's card, the rules by what
 * Claude does under each group's dot, the always-on rules' card, the check's line and "Check real
 * situations".
 */
export function DraftRulesSkeleton() {
  return (
    <div className="cd-setup-skeleton">
      <div className="cd-outcome-groups">
        <SkeletonCard padding={16} anchor="rules-money-limit">
          <div className="cd-money-limit cd-money-limit--prominent">
            <div className="cd-money-limit__reading">
              <div className="cd-money-limit__line">
                <Lines count={{ wide: 1, phone: 2 }} last="80%" phoneLast="45%" />
              </div>
            </div>
          </div>
        </SkeletonCard>
        {RULE_GROUPS.map((group, g) => (
          <div key={g} className="cd-outcome-groups__group">
            <SkeletonCard padding={16}>
              <div className="cd-outcome-groups__title cd-type-control">
                <Skeleton shape="circle" size={6} />
                <Skeleton shape="line" text="control" width={group.title} />
              </div>
              <ul className="cd-outcome-groups__rows">
                {group.rows.map((row, i) => (
                  <li key={i} className="cd-outcome-groups__row" data-skeleton-anchor={`rules-${GROUP_NAMES[g]}-row-${i}`}>
                    <span className="cd-outcome-groups__text cd-type-body">
                      <Lines count={{ wide: 1, phone: row.phone }} last={row.text} phoneLast={row.phoneLast} />
                    </span>
                    <span className="cd-outcome-groups__who cd-type-meta">
                      <Skeleton shape="line" text="meta" width={row.who} />
                    </span>
                  </li>
                ))}
              </ul>
            </SkeletonCard>
          </div>
        ))}
      </div>
      <SkeletonCard padding={16}>
        <div className="cd-always-on">
          <div className="cd-section-header">
            <div className="cd-section-header__title">
              <Skeleton shape="line" text="section" width={69} />
            </div>
            {/* The caption keeps its width, so on a phone it drops under the title as the words do. */}
            <div className="cd-section-header__caption">
              <Skeleton shape="line" text="meta" width={369} />
              <Skeleton shape="line" text="meta" width={180} className="cd-setup-skeleton__phone-line" />
            </div>
          </div>
          <ul className="cd-always-on__list">
            {ALWAYS_ON_LINES.map((line, i) => (
              <li key={i} className="cd-always-on__item cd-type-body">
                <span className="cd-always-on__lock cd-setup-skeleton__lock">
                  <Skeleton shape="block" width={14} height={14} />
                </span>
                <span className="cd-setup-skeleton__fill">
                  <Lines count={{ wide: 1, phone: line.phone }} last={line.width} phoneLast={line.phoneLast} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </SkeletonCard>
      <ul className="cd-setup-rules__checks">
        <li className="cd-type-meta">
          <span className="cd-status-label">
            <Skeleton shape="circle" size={6} />
            <Skeleton shape="line" text="meta" width={337} />
          </span>
        </li>
      </ul>
      <div className="cd-setup-step__actions">
        <MainButton label="Check real situations" />
      </div>
    </div>
  );
}

/** A step's main button, as wide as its label makes the real one. */
function MainButton({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'secondary' }) {
  return (
    <Skeleton
      shape="block"
      measure={{ label, className: `cd-button cd-button--${variant} cd-button--main cd-type-control` }}
      height="var(--size-control-main)"
      anchor={variant === 'primary' ? 'main-button' : undefined}
    />
  );
}

/** One situation's row: its title's width on a laptop and its lines on a phone, who is asking, and the reason. */
interface SituationShape {
  title: string;
  phone: number;
  phoneLast?: string;
  who: string;
  reason: string;
  /** "Not what we planned" under who is asking. */
  flag?: boolean;
}

/**
 * The situations a fresh copy's draft is tried on: a weekday drain, a cash discount, an agent's
 * deposit, a customer's invoice, a Saturday visit the draft doesn't book as planned, and another
 * customer's address.
 */
const SITUATIONS: readonly SituationShape[] = [
  { title: '92%', phone: 2, phoneLast: '30%', who: '35%', reason: '40%' },
  { title: '75%', phone: 1, who: '35%', reason: '27%' },
  { title: '68%', phone: 1, who: '48%', reason: '55%' },
  { title: '66%', phone: 1, who: '33%', reason: '42%' },
  { title: '95%', phone: 2, phoneLast: '15%', who: '34%', reason: '40%', flag: true },
  { title: '76%', phone: 1, who: '35%', reason: '45%' },
];

/**
 * "Real situations" while the draft is tried on them: a card of `SituationRow`s, what happens and
 * who is asking at the left, the outcome beside its dot and the reason at the right, then "Looks
 * right". No outcome's colour is drawn: every dot is a shape.
 */
export function SituationsSkeleton() {
  return (
    <div className="cd-setup-skeleton">
      <SkeletonCard padding={16}>
        <ul className="cd-setup-step__rows">
          {SITUATIONS.map((row, i) => (
            <li key={i} data-skeleton-anchor={`situation-row-${i}`}>
              <div className="cd-situation-row">
                <div className="cd-situation-row__grid">
                  <div className="cd-situation-row__situation">
                    <Lines count={{ wide: 1, phone: row.phone }} text="control" last={row.title} phoneLast={row.phoneLast} />
                    <div className="cd-situation-row__who">
                      <Skeleton shape="line" text="meta" width={row.who} />
                    </div>
                    {row.flag ? (
                      <div className="cd-setup-skeleton__flag">
                        <Skeleton shape="line" text="caption" width={130} />
                      </div>
                    ) : null}
                  </div>
                  <ResultShape reason={row.reason} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </SkeletonCard>
      <div className="cd-setup-step__actions">
        <MainButton label="Looks right" />
      </div>
    </div>
  );
}

/** A row's right column, as `SituationRow` and `SafetyCheckRow` draw it: the outcome beside its dot, the reason under it. */
function ResultShape({ reason, kind = 'situation' }: { reason: string; kind?: 'situation' | 'safety-check' }) {
  return (
    <div className={`cd-${kind}-row__result`}>
      <div className={`cd-${kind}-row__outcome cd-type-meta`}>
        <Skeleton shape="circle" size={6} />
        <Skeleton shape="line" text="meta" width={64} />
      </div>
      <div className={`cd-${kind}-row__reason`}>
        <Skeleton shape="line" text="meta" width={reason} />
      </div>
    </div>
  );
}

/** The tricks a fresh copy's draft is tried with, each one line of words at both widths. */
const TRICKS: readonly { label: string; attempt: string; reason: string }[] = [
  { label: '30%', attempt: '70%', reason: '78%' },
  { label: '55%', attempt: '28%', reason: '72%' },
  { label: '46%', attempt: '62%', reason: '45%' },
  { label: '44%', attempt: '55%', reason: '82%' },
  { label: '43%', attempt: '50%', reason: '55%' },
  { label: '47%', attempt: '48%', reason: '80%' },
];

/**
 * "Safety check" while the draft or the check is read: the count and the line under it, a card of
 * `SafetyCheckRow`s (the trick, the words it tried and the checkpoint at the left; the outcome
 * beside its dot and the reason at the right), then "Confirm rules" and "Run again".
 */
export function SafetyCheckSkeleton() {
  return (
    <div className="cd-setup-skeleton">
      <div className="cd-setup-safety__summary">
        <Skeleton shape="line" text="summary" width={140} anchor="safety-count" />
        <div>
          <Lines count={{ wide: 1, phone: 2 }} last="85%" phoneLast="50%" />
        </div>
      </div>
      <SkeletonCard padding={16}>
        <ul className="cd-setup-step__rows">
          {TRICKS.map((row, i) => (
            <li key={i} data-skeleton-anchor={`trick-row-${i}`}>
              <div className="cd-safety-check-row">
                <div className="cd-safety-check-row__grid">
                  <div className="cd-safety-check-row__trick">
                    <Skeleton shape="line" text="control" width={row.label} />
                    <div className="cd-safety-check-row__attempt">
                      <Skeleton shape="line" text="meta" width={row.attempt} />
                    </div>
                    <div className="cd-safety-check-row__checkpoint">
                      <Skeleton shape="line" text="caption" width={110} />
                    </div>
                  </div>
                  <ResultShape kind="safety-check" reason={row.reason} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </SkeletonCard>
      <div className="cd-setup-step__actions">
        <MainButton label="Confirm rules" />
        <MainButton label="Run again" variant="secondary" />
      </div>
    </div>
  );
}
