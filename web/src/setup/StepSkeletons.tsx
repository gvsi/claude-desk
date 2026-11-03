/**
 * Setup's steps as quiet shapes while their reads are out, each built from its own components'
 * classes so the step lands where the shapes were. They draw what a fresh copy's interview shows:
 * the seed's connectors, then the draft, situations and tricks the example answers make, and the
 * lines customers will read. Words the app knows before the read lands (the connectors' names and
 * lines, the always-on rules, the payment limit's and the safety check's own lines, the public
 * lines' labels) are measured in the current fonts at their real width, so the shapes take the
 * lines the words will, on any platform. Words that come with the read (the rules, the situations,
 * the tricks, the public lines) are estimates: when they wrap differently, the rows under them move
 * once as they land. A skeleton draws no words.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { Effect, RuleCard, ToolName } from '../api/contracts.ts';
import type { ToolRow } from '../api/views.ts';
import { PageHeaderSkeleton, Skeleton, SkeletonCard, SkeletonScreen, type SkeletonText } from '../ds/index.ts';
import { connectorByKey, type ConnectorKey } from '../owner/connectors/catalog.ts';
import type { ToolsView } from '../owner/rules/HouseRules.tsx';
import { ToolRulesShapes } from '../owner/rules/RulesSkeleton.tsx';
import { PUBLIC_LINE_KEYS, SETUP_COPY } from './copy.ts';
import { publicLineLabel } from './publicLinesFormat.ts';

/**
 * Setup's column while the interview itself is read ("Opening your setup"): a step's header as
 * shapes, since every step opens with a `PageHeader`, a title over a line (two on a phone). The
 * step is drawn in it once read: a step whose own read is still out carries the shapes on at once
 * under its real header, so a reload never goes blank between the two. Meanwhile the page keeps one
 * heading, setup's name, visually hidden outside the shapes, as Today's opening does; the step's own
 * title replaces it in the commit the step is drawn in.
 */
export function SetupOpening({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return (
    <>
      {loading ? <h1 className="cd-sr-only">{SETUP_COPY.stepsLabel}</h1> : null}
      <SkeletonScreen className="cd-setup-opening" loading={loading} status={SETUP_COPY.questions.loading} skeleton={<PageHeaderSkeleton subtitleLines={{ wide: 1, phone: 2 }} />}>
        {children}
      </SkeletonScreen>
    </>
  );
}

/** A secondary button inline in a row, as "Add" and "Connect" are drawn. */
const ROW_BUTTON = 'cd-button cd-button--secondary cd-button--inline cd-type-control';

/** The payment limit the draft's money rules are worded at: the amount is the owner's answer, the words the app's. */
const MEASURED_LIMIT_CENTS = 50_000;

/** The tricks the safety check's own lines are measured with: the count is the check's, the words the app's. */
const MEASURED_TRICKS = 6;

/**
 * The width of each line `words` take in `box`, in px: set in the box's own font, at its width, by
 * an invisible probe that leaves no words behind. Measured again when the box resizes and when
 * fonts load, so the lines follow the fonts this browser draws with.
 */
function useLineWidths(box: RefObject<HTMLElement | null>, words: string): readonly number[] | null {
  const [widths, setWidths] = useState<readonly number[] | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected) return;
      const probe = document.createElement('span');
      probe.textContent = words;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', display: 'block', width: `${element.getBoundingClientRect().width}px`, visibility: 'hidden', pointerEvents: 'none' });
      element.append(probe);
      try {
        const range = document.createRange();
        range.selectNodeContents(probe);
        const lines = new Map<number, { left: number; right: number }>();
        for (const rect of range.getClientRects()) {
          if (rect.width === 0) continue;
          const top = Math.round(rect.top);
          const line = lines.get(top);
          lines.set(top, line ? { left: Math.min(line.left, rect.left), right: Math.max(line.right, rect.right) } : { left: rect.left, right: rect.right });
        }
        const next = [...lines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line.right - line.left);
        setWidths((now) => (now !== null && now.length === next.length && now.every((width, i) => Math.abs(width - next[i]!) < 0.5) ? now : next));
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      live = false;
      observer?.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [box, words]);
  return widths;
}

/**
 * Known words as lines of shapes: one pill per line the words take here, as long as that line.
 * Put it where the words go, inside the element that gives them their type and width.
 */
function MeasuredLines({ words, text = 'body' }: { words: string; text?: SkeletonText }) {
  const box = useRef<HTMLSpanElement>(null);
  const widths = useLineWidths(box, words);
  return (
    <span ref={box} className="cd-setup-skeleton__measured">
      {(widths ?? [Number.NaN]).map((width, i) => (
        <Skeleton key={i} shape="line" text={text} width={Number.isNaN(width) ? '100%' : width} />
      ))}
    </span>
  );
}

/**
 * How many lines some words take: the same at every width, or apart on a phone, whose column can be
 * narrower than a laptop's (a row's title) or wider (a row's right column, which drops under it).
 */
type LineCount = number | { wide: number; phone: number };

/**
 * Lines of one type style for words that come with the read, an estimate: the last one short
 * (`last`, or `phoneLast` for a phone's). Where a phone wraps the words onto other lines, the
 * laptop's lines and the phone's are drawn apart, each shown only at its own width.
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
  return wide === phone && last === phoneLast ? <>{set(wide)}</> : <>{set(wide, 'wide')}{set(phone, 'phone')}</>;
}

/** A fresh Desk's built-in connectors, in the catalog's order, and where each stands or its button. */
const BUILT_IN: readonly { key: ConnectorKey; end: 'on' | 'always_on' | 'add' }[] = [
  { key: 'quotes', end: 'on' },
  { key: 'bookings', end: 'on' },
  { key: 'leads', end: 'on' },
  { key: 'verification', end: 'always_on' },
  { key: 'documents', end: 'add' },
  { key: 'payments', end: 'add' },
];

/** The row's tile and its name over its line, as `ConnectorSummary` draws them, from the catalog's words. */
function ToolSummary({ connector, badge = false }: { connector: ConnectorKey; badge?: boolean }) {
  const view = connectorByKey(connector)?.view;
  return (
    <>
      <Skeleton shape="block" className="cd-connector-icon cd-connector-icon--section" />
      <span className="cd-connector-summary">
        <span className="cd-connector-summary__name cd-type-body">
          {badge ? (
            // The name and its badge ride the name's line as the real ones do, set on its middle, so
            // the line is as deep as the badge makes it.
            <>
              <Skeleton shape="block" width={37} height={12} radius="full" className="cd-setup-skeleton__inline" />{' '}
              <Skeleton shape="block" width={48} height="var(--space-20)" radius="full" className="cd-setup-skeleton__inline cd-setup-skeleton__badge" />
            </>
          ) : (
            <MeasuredLines words={view?.name ?? ''} />
          )}
        </span>
        <span className="cd-connector-summary__description cd-type-meta">
          <MeasuredLines words={view?.description ?? ''} text="meta" />
        </span>
      </span>
    </>
  );
}

/** Where a built-in connector stands, or its button. */
function ToolEnd({ end }: { end: (typeof BUILT_IN)[number]['end'] }) {
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
            <li key={row.key} className="cd-setup-tools__row" data-skeleton-anchor={`tools-built-in-row-${i}`}>
              <ToolSummary connector={row.key} />
              <ToolEnd end={row.end} />
            </li>
          ))}
        </ul>
      </SkeletonCard>
      <SkeletonCard padding={16}>
        <Skeleton shape="line" text="control" width={118} className="cd-setup-tools__heading" />
        <ul className="cd-setup-tools__rows">
          <li className="cd-setup-tools__row" data-skeleton-anchor="tools-external-row-0">
            <ToolSummary connector="stripe" badge />
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

/** A built-in tool a fresh copy's setup turns on, as the kernel's tool rows have it. */
function draftTool(tool: ToolName, effects: Effect[], reversible = true): ToolRow {
  return {
    tool, source: 'native', effects, reversible, status: 'enabled', description_confirmed: '',
    definition_sha256: null, pending_definition_text: null, pending_sha256: null, review_reason: null, business: null,
  };
}

/** A rule for anyone on `applies_to`, automatic unless `fields` says otherwise. */
function draftCard(card_id: string, applies_to: RuleCard['applies_to'], fields: Partial<RuleCard> = {}): RuleCard {
  return {
    card_id, applies_to, mode: 'auto', who: 'anyone', person_id: null, agent_key_id: null, max_amount_cents: null,
    max_discount_bp: 0, hours: null, review: false, is_default: false, reason: '', ...fields,
  };
}

/**
 * The draft a fresh copy's example answers make, as Your rules lists it, for the shapes alone:
 * the built-in connectors setup starts on (Quotes, Bookings, Leads and callbacks, Verification),
 * the ask-first preset's open rules, quotes at list price, and weekday bookings in the opening
 * hours with Saturday's asking first; and its payments asking first and money never going out,
 * which cover no tool that is on yet, so they sit under "Other tools", as Rules lists them. The
 * page's own model (`toolGroups`) words it, never shown.
 */
const DRAFT_SAMPLE: ToolsView = {
  tools: [
    draftTool('native.quote', ['change']),
    draftTool('native.find_slots', ['read']),
    draftTool('native.book', ['change']),
    draftTool('native.capture_lead', ['change']),
    draftTool('native.request_callback', ['change']),
    draftTool('native.start_verification', ['send_message'], false),
  ],
  active: {
    cards: [
      draftCard('find-slots', 'native.find_slots'),
      draftCard('capture-lead', 'native.capture_lead'),
      draftCard('request-callback', 'native.request_callback'),
      draftCard('start-verification', 'native.start_verification'),
      draftCard('quote', 'native.quote'),
      draftCard('book-weekdays', 'native.book', { hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' } }),
      draftCard('book-saturday', 'native.book', { mode: 'ask', hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' } }),
      draftCard('payments', 'effect:charge', { mode: 'ask' }),
      draftCard('money-out', 'effect:pay_out', { mode: 'never' }),
    ],
  },
};

/**
 * "Your rules" while the draft is made (`DraftRules`): Rules' own shapes (`ToolRulesShapes`), read
 * only, over a fresh copy's draft: "Across your Desk", then "Tool by tool" with each connector's
 * tools and their rules; then the check's line and "Check real situations".
 */
export function DraftRulesSkeleton() {
  return (
    <div className="cd-setup-skeleton">
      <ToolRulesShapes sample={DRAFT_SAMPLE} cap={MEASURED_LIMIT_CENTS} toolsCaption={SETUP_COPY.rules.toolsCaption} version={null} readOnly className="cd-setup-skeleton" />
      <ul className="cd-setup-rules__checks" data-skeleton-anchor="rules-checks">
        <li className="cd-type-meta">
          <span className="cd-status-label">
            <Skeleton shape="circle" size={6} />
            <Skeleton shape="line" text="meta" width={337} />
          </span>
        </li>
      </ul>
      <div className="cd-setup-step__actions">
        <MainButton label={SETUP_COPY.rules.checkSituations} />
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

/** One situation's row: its title's lines (`title` the last one's width on a laptop), who is asking, and its reason. */
interface SituationShape {
  title: string;
  /** The title's lines on a laptop: 1 when left out. */
  wide?: number;
  phone: number;
  phoneLast?: string;
  who: string;
  reason: ReasonShape;
  /** "Not what we planned" under who is asking. */
  flag?: boolean;
}

/**
 * A row's reason: the kernel's own words, one meta line this wide, or, for a situation one draft
 * rule decided, that rule's sentence (`RuleSentence`), body lines in the right column's width: 300 px
 * on a laptop, the whole row on a phone, where it drops under who is asking.
 */
type ReasonShape = string | { sentence: LineCount; last: string; phoneLast?: string };

/**
 * The situations a fresh copy's draft is tried on, at the lines and widths a fresh CPA copy's words
 * take: a weekday drain and a Saturday visit the draft doesn't book as planned, read as the bookings
 * rule's sentence; a cash discount in the kernel's words; an agent's deposit and a customer's
 * invoice, read as their rules' sentences; and another customer's address in the kernel's words.
 */
const SITUATIONS: readonly SituationShape[] = [
  { title: '98%', phone: 2, phoneLast: '20%', who: '36%', reason: { sentence: 2, last: '32%', phoneLast: '17%' } },
  { title: '77%', phone: 1, who: '36%', reason: '49%' },
  { title: '71%', phone: 1, who: '52%', reason: { sentence: 2, last: '67%', phoneLast: '55%' } },
  { title: '70%', phone: 1, who: '35%', reason: { sentence: { wide: 2, phone: 1 }, last: '25%', phoneLast: '94%' } },
  { title: '10%', wide: 2, phone: 2, phoneLast: '22%', who: '36%', reason: { sentence: 2, last: '32%', phoneLast: '17%' }, flag: true },
  { title: '87%', phone: 1, who: '36%', reason: '81%' },
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
                    <Lines count={{ wide: row.wide ?? 1, phone: row.phone }} text="control" last={row.title} phoneLast={row.phoneLast} />
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
        <MainButton label={SETUP_COPY.changeSomething} variant="secondary" />
        <MainButton label={SETUP_COPY.situations.looksRight} />
      </div>
    </div>
  );
}

/** A row's right column, as `SituationRow` and `SafetyCheckRow` draw it: the outcome beside its dot, the reason under it. */
function ResultShape({ reason, kind = 'situation' }: { reason: ReasonShape; kind?: 'situation' | 'safety-check' }) {
  return (
    <div className={`cd-${kind}-row__result`}>
      <div className={`cd-${kind}-row__outcome cd-type-meta`}>
        <Skeleton shape="circle" size={6} />
        <Skeleton shape="line" text="meta" width={64} />
      </div>
      <div className={`cd-${kind}-row__reason`}>
        {typeof reason === 'string' ? <Skeleton shape="line" text="meta" width={reason} /> : <Lines count={reason.sentence} last={reason.last} phoneLast={reason.phoneLast} />}
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
        <div className="cd-setup-safety__count cd-type-summary" data-skeleton-anchor="safety-count">
          <MeasuredLines words={SETUP_COPY.safety.stopped(MEASURED_TRICKS, MEASURED_TRICKS)} text="summary" />
        </div>
        <div className="cd-setup-step__line cd-type-body">
          <MeasuredLines words={SETUP_COPY.safety.lead(MEASURED_TRICKS)} />
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
        <MainButton label={SETUP_COPY.safety.confirm} />
        <MainButton label={SETUP_COPY.safety.runAgain} variant="secondary" />
      </div>
    </div>
  );
}

/**
 * One of the owner's lines customers will read: its key, which names its label, and where each of
 * its paragraphs' lines ends on a laptop and on a phone, in px. The words come with the read, so
 * their lines are estimates: a fresh copy's own, the last line of a wrapped value short.
 */
interface PublicLineShape {
  key: (typeof PUBLIC_LINE_KEYS)[number];
  wide: readonly (readonly number[])[];
  phone: readonly (readonly number[])[];
}

/**
 * A fresh copy's lines, in the step's order: about, getting started, after hours, urgent help, the
 * service area, and how we help, three short paragraphs Claude writes from the rules.
 */
const PUBLIC_LINES: readonly PublicLineShape[] = [
  { key: 'policy:about', wide: [[477, 310]], phone: [[256, 217, 235, 71]] },
  { key: 'policy:intake', wide: [[465, 455, 58]], phone: [[250, 252, 225, 248]] },
  { key: 'policy:after_hours', wide: [[477, 84]], phone: [[255, 218, 84]] },
  { key: 'policy:urgent', wide: [[486, 135]], phone: [[247, 235, 135]] },
  { key: 'policy:service_area', wide: [[361]], phone: [[252, 106]] },
  { key: 'policy:how_we_help', wide: [[265], [365], [378]], phone: [[265], [298, 64], [300, 75]] },
];

/** How we help is Claude's, from the rules: it has no Edit, and its words take the row's width. */
const READ_ONLY_LINE = 'policy:how_we_help';

/** A paragraph's lines, a laptop's and a phone's, each shown only at its own width. */
function ParagraphLines({ wide, phone }: { wide: readonly number[]; phone: readonly number[] }) {
  return (
    <>
      {wide.map((width, i) => (
        <Skeleton key={`wide-${i}`} shape="line" width={width} className="cd-setup-skeleton__wide-line" />
      ))}
      {phone.map((width, i) => (
        <Skeleton key={`phone-${i}`} shape="line" width={width} className="cd-setup-skeleton__phone-line" />
      ))}
    </>
  );
}

/**
 * "What customers will read" while the lines are read: the owner's lines in their card, each its
 * label, its words and Edit at the row's top right, then "Looks right". Claude's suggestions aren't
 * drawn: when they come with the read, their card lands above the lines, which move down once.
 */
export function PublicLinesSkeleton() {
  return (
    <div className="cd-setup-skeleton">
      <SkeletonCard padding={16} anchor="public-lines-card">
        <div className="cd-public-lines cd-public-lines--owned">
          {PUBLIC_LINES.map((line, i) => (
            <div
              key={line.key}
              className={`cd-public-lines__row${line.key === READ_ONLY_LINE ? ' cd-public-lines__row--readonly' : ''}`}
              data-skeleton-anchor={`public-lines-row-${i}`}
            >
              <span className="cd-public-lines__label cd-type-meta" data-skeleton-anchor={`public-lines-label-${i}`}>
                <MeasuredLines words={publicLineLabel(line.key) ?? ''} text="meta" />
              </span>
              <div className="cd-public-lines__text">
                {line.wide.map((wide, p) => (
                  <p key={p}>
                    <ParagraphLines wide={wide} phone={line.phone[p] ?? []} />
                  </p>
                ))}
              </div>
              {line.key === READ_ONLY_LINE ? null : (
                <div className="cd-public-lines__actions">
                  <Skeleton
                    shape="block"
                    measure={{ label: SETUP_COPY.publicLines.edit, className: ROW_BUTTON }}
                    height="var(--size-control)"
                    anchor={`public-lines-edit-${i}`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </SkeletonCard>
      <div className="cd-setup-step__actions">
        <MainButton label={SETUP_COPY.situations.looksRight} />
      </div>
    </div>
  );
}
