import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { MONEY_EFFECTS, type Effect, type RuleCard } from '../../api/contracts.ts';
import type { PolicyVersionOut, RulesView, ToolRow } from '../../api/views.ts';
import { Icon, Skeleton, SkeletonCard, type SentencePart, type SkeletonText } from '../../ds/index.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { listWords } from '../../lib/format.ts';
import { useTextBox, useTextLines, type TextPart } from '../../lib/useTextLines.ts';
import { COMPOSER_HELPER, RULES_CHIPS, RULES_FALLBACK, RULES_SECTIONS, RULES_SUBTITLE, rulesVersionLine } from './copy.ts';
import { moneyTitles, toolGroups, type ToolsView } from './HouseRules.tsx';
import { ACROSS_DESK_SENTENCES, ALWAYS_ON_SENTENCES, moneyCapBandSentence, moneyCapSentence } from './ruleSentence.ts';

import './RulesPage.css';
import './HouseRules.css';

/** Intrinsic width in the real CSS/font; drawn controls use public Skeleton.measure. */
function useMeasuredWidth(
  box: RefObject<HTMLDivElement | null>,
  control?: {
    label: string;
    className: string;
    tagName?: 'a' | 'button' | 'span';
    suffix?: { className: string; width: string };
  },
): number | undefined {
  const [width, setWidth] = useState<number>();
  const { label, className, tagName, suffix } = control ?? {};
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || label === undefined || className === undefined) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected) return;
      const probe = document.createElement(tagName ?? 'button');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none' });
      probe.append(label);
      if (suffix) {
        const icon = document.createElement('span');
        icon.className = suffix.className;
        icon.style.width = suffix.width;
        probe.append(icon);
      }
      element.append(probe);
      const next = Math.ceil(probe.getBoundingClientRect().width);
      probe.remove();
      setWidth((was) => (was === next ? was : next));
    };
    measure();
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [box, label, className, tagName, suffix?.className, suffix?.width]);
  return control ? width : undefined;
}

/** Known copy is measured, never drawn: wrapping follows this column and this browser's fonts. */
function useLineWidths(box: RefObject<HTMLDivElement | null>, words: string, className: string, precise: boolean) {
  const [widths, setWidths] = useState<number[]>();
  useLayoutEffect(() => {
    const element = box.current;
    if (!precise || !element) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected || element.closest('[data-state="leaving"]')) return;
      const probe = document.createElement('p');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: `${element.getBoundingClientRect().width}px`, margin: '0' });
      probe.textContent = words;
      element.append(probe);
      try {
        const range = document.createRange();
        range.selectNodeContents(probe);
        const next = [...range.getClientRects()].map(({ width }) => width);
        setWidths((was) => JSON.stringify(was) === JSON.stringify(next) ? was : next);
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [box, words, className, precise]);
  return precise ? widths : undefined;
}

function Lines({
  words,
  className,
  text = 'body',
  anchor,
  fitted = false,
  precise = false,
  parts,
}: {
  words: string;
  className: string;
  text?: SkeletonText;
  anchor?: string;
  fitted?: boolean;
  precise?: boolean;
  /** The words in runs, when some are set in another weight: they break where the page's do. */
  parts?: readonly TextPart[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(box, fitted ? { label: words, className, tagName: 'span' } : undefined);
  const count = useTextLines(box, { parts: parts ?? [words], className }, 1);
  const widths = useLineWidths(box, words, className, precise);
  return (
    <div ref={box} className={className} style={fitted && width !== undefined ? { width: Math.ceil(width) } : undefined} data-skeleton-anchor={anchor}>
      {Array.from({ length: widths?.length ?? count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={widths?.[i] ?? (i ? '70%' : '100%')} />
      ))}
    </div>
  );
}

/** A control's own styles determine both its height and its label width: a button's, or another element's (`tagName`). */
function Control({ label, className, anchor, suffix = false, tagName }: {
  label: string; className: string; anchor?: string; suffix?: boolean; tagName?: 'a' | 'button' | 'span';
}) {
  const box = useRef<HTMLDivElement>(null);
  const measure = {
    label,
    className,
    tagName: tagName ?? (className.includes('cd-text-link') ? ('a' as const) : ('button' as const)),
    ...(suffix
      ? {
          suffix: {
            className: 'cd-rules-skeleton__suffix',
            width: 'var(--space-14)',
          },
        }
      : {}),
  };
  const width = useMeasuredWidth(box, measure);
  const { height } = useTextBox(box, { parts: [label], className }, 1);
  return (
    <div ref={box} className="cd-rules-skeleton__control" style={width === undefined ? undefined : { width: Math.ceil(width) }}>
      <Skeleton shape="block" measure={measure} height={height} anchor={anchor} />
    </div>
  );
}

function Header() {
  return (
    <>
      <div className="cd-rules__header">
        <div className="cd-page-header cd-page-header--actions-below cd-page-header--no-phone-subtitle">
          <div className="cd-page-header__text">
            <Skeleton shape="line" text="page-title" width={100} className="cd-page-header__title" anchor="rules-title" />
            <Lines
              words={RULES_SUBTITLE}
              className="cd-page-header__subtitle cd-type-body"
              anchor="rules-subtitle"
            />
          </div>
          <div className="cd-page-header__actions">
            <div className="cd-preset-menu">
              <Control
                label="Start from a preset"
                className="cd-button cd-button--secondary cd-button--main cd-button--menu cd-type-control"
                suffix
                anchor="rules-preset"
              />
            </div>
          </div>
        </div>
      </div>
      <div className="cd-rules__ask">
        <div className="cd-composer">
          <div className="cd-composer__box cd-composer__box--stacked" data-skeleton-anchor="rules-composer">
            <Skeleton shape="line" text="message" className="cd-composer__input" width="60%" />
            <div className="cd-composer__tools">
              <Lines
                words={COMPOSER_HELPER}
                className="cd-composer__helper cd-type-caption"
                text="caption"
              />
              <Skeleton shape="block" width="var(--size-control)" height="var(--size-control)" />
            </div>
          </div>
        </div>
        <div className="cd-suggestion-chips">
          {[...RULES_CHIPS, 'Why was this quote held?'].map((label) => (
            <Control key={label} label={label} className="cd-chip cd-type-pill" />
          ))}
        </div>
      </div>
    </>
  );
}

/** A tool Turner Plumbing starts with, on, as the kernel's tool rows have it. */
function sampleTool(tool: string, effects: Effect[], fields: Partial<ToolRow> = {}): ToolRow {
  return {
    tool, source: 'native', effects, reversible: true, status: 'enabled', description_confirmed: '',
    definition_sha256: null, pending_definition_text: null, pending_sha256: null, review_reason: null, business: null,
    ...fields,
  } as ToolRow;
}

/** An automatic rule for anyone on `tool`, as Turner's starter rules are. */
const sampleCard = (tool: string): RuleCard => ({ ...rivera.ruleCards['rv-quote'], card_id: `shape:${tool}`, applies_to: tool });

/**
 * A fresh Turner copy's rules, the first load's shapes: its tools and cards, worded by the page's own
 * model (`toolGroups`), so the shapes break and stack as its rows do. Never shown as words.
 */
const SAMPLE: RulesView = {
  active: {
    version: 7,
    auto_money_cap_cents: 50_000,
    cards: [
      ...['native.find_slots', 'native.capture_lead', 'native.request_callback', 'native.start_verification', 'desk.emergency-callback'].map(sampleCard),
      ...Object.values(rivera.ruleCards),
    ],
  } as unknown as PolicyVersionOut,
  tools: [
    sampleTool('native.quote', ['change']),
    sampleTool('native.find_slots', ['read']),
    sampleTool('native.book', ['change']),
    sampleTool('native.release_document', ['private_data', 'send_message'], { reversible: false }),
    sampleTool('native.payment_link', ['charge'], { reversible: false }),
    sampleTool('native.charge_mandate', ['charge'], { reversible: false }),
    sampleTool('native.capture_lead', ['change']),
    sampleTool('native.request_callback', ['change']),
    sampleTool('native.start_verification', ['send_message'], { reversible: false }),
    sampleTool('payments.list_charges', ['private_data'], { source: 'mcp' }),
    sampleTool('payments.create_refund', ['pay_out', 'private_data'], { source: 'mcp', reversible: false }),
    sampleTool('desk.emergency-callback', ['change'], {
      source: 'business',
      business: {
        title: 'Emergency callback',
        description: 'Asks Mike to call back urgently about an emergency.',
        config: { block: 'urgent', urgent_when: 'A burst or leaking pipe, flooding, a sewage backup, or no water' },
      },
    }),
  ],
  preset: null,
};

/** How many lines each of the body's text shapes takes, by its id, measured in one pass (`useShapeLines`). */
const ShapeLines = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * A text shape in the body: as many lines as its words take in its column and its type, which
 * `useShapeLines` measures for every shape at once. Its words stay in an attribute, never as text.
 */
function TextShape({ id, parts, className, text = 'body', anchor }: { id: string; parts: readonly TextPart[]; className: string; text?: SkeletonText; anchor?: string }) {
  const lines = useContext(ShapeLines).get(id) ?? 1;
  return (
    <div className={className} data-shape-id={id} data-shape-parts={JSON.stringify(parts)} data-skeleton-anchor={anchor}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i ? '70%' : '100%'} />
      ))}
    </div>
  );
}

type Edge = 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom' | 'borderLeftWidth' | 'borderRightWidth' | 'borderTopWidth' | 'borderBottomWidth';

/** The sum of a box's edges, in px. */
const sumOf = (style: CSSStyleDeclaration, edges: readonly Edge[]): number =>
  edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);

/**
 * Every `TextShape`'s line count under `root`, measured together: all their widths read first, then
 * a probe of each one's words in its own type and width, then all the probes' heights, so the many
 * shapes cost two layouts, not two each. Again as the body resizes and as fonts load.
 */
function useShapeLines(root: RefObject<HTMLElement | null>): ReadonlyMap<string, number> {
  const [lines, setLines] = useState<ReadonlyMap<string, number>>(new Map());
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected || element.closest('[data-state="leaving"]')) return;
      const shapes = [...element.querySelectorAll<HTMLElement>('[data-shape-id]')];
      const widths = shapes.map((shape) => shape.getBoundingClientRect().width - sumOf(getComputedStyle(shape), ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']));
      const probes = shapes.map((shape, i) => {
        const probe = document.createElement('p');
        probe.className = shape.className;
        probe.inert = true;
        probe.setAttribute('aria-hidden', 'true');
        Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', boxSizing: 'border-box', width: `${Math.max(0, widths[i] ?? 0)}px`, margin: '0' });
        for (const part of JSON.parse(shape.dataset.shapeParts ?? '[]') as TextPart[]) {
          if (typeof part === 'string') probe.append(part);
          else {
            const span = document.createElement('span');
            span.className = part.className;
            span.textContent = part.text;
            probe.append(span);
          }
        }
        shape.append(probe);
        return probe;
      });
      const next = new Map<string, number>();
      probes.forEach((probe, i) => {
        const own = getComputedStyle(probe);
        const lineHeight = Number.parseFloat(own.lineHeight);
        const inner = probe.getBoundingClientRect().height - sumOf(own, ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']);
        const id = shapes[i]?.dataset.shapeId;
        if (id !== undefined && lineHeight > 0 && (widths[i] ?? 0) > 0) next.set(id, Math.max(1, Math.round(inner / lineHeight)));
      });
      for (const probe of probes) probe.remove();
      setLines((was) => (was.size === next.size && [...next].every(([id, count]) => was.get(id) === count) ? was : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer?.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [root]);
  return lines;
}

/**
 * Words the page draws in a control or label, held here only to give the shape over them their
 * width: drawn by RulesPage.css from the attribute, unseen, so the shapes carry no text.
 */
function WordsShape({ words, className, children }: { words: string; className: string; children?: ReactNode }) {
  return (
    <span className="cd-rules-skeleton__words-box">
      <span className={`${className} cd-rules-skeleton__words`} data-words={words} aria-hidden="true">{children}</span>
      <Skeleton shape="block" width="100%" height="100%" className="cd-rules-skeleton__over" />
    </span>
  );
}

/**
 * Details' place at a row's end, the width of the page's button, unseen and with no words of its
 * own: the shapes carry none (RulesPage.css draws "Details" as the place's content).
 */
function DetailsSpace() {
  return (
    <span className="cd-advanced-details__toggle cd-advanced-details__slot cd-rules-skeleton__details cd-type-control" aria-hidden="true">
      <Icon name="chevron-right" size={14} className="cd-advanced-details__chevron" />
    </span>
  );
}

/** A sentence's runs, a key value in its weight, as the page breaks them. */
const runsOf = (parts: readonly SentencePart[]): TextPart[] => parts.map((part) => (part.key === true ? { text: part.text, className: 'cd-rule-sentence__key' } : part.text));

/**
 * A rule row's shape: its sentence and line, then its status dot and Details' place, "Change" first
 * on the payment limit's, or "Always on". Setup's rows have no Details, so no place (`details`).
 */
function RuleShape({ id, parts, line, end, details = true }: { id: string; parts: readonly SentencePart[]; line?: string; end: 'dot' | 'change' | 'always'; details?: boolean }) {
  return (
    <div className="cd-house-rules__rule">
      <div className="cd-house-rules__rule-row">
        <div className="cd-house-rules__rule-text">
          <div className="cd-rule-sentence">
            <div className="cd-rule-sentence__layout">
              <div className="cd-rule-sentence__text">
                <TextShape id={`${id}:sentence`} parts={runsOf(parts)} className="cd-rule-sentence__sentence cd-type-body" />
              </div>
            </div>
          </div>
          {line === undefined || line === '' ? null : <TextShape id={`${id}:line`} parts={[line]} className="cd-house-rules__rule-line cd-type-meta" text="meta" />}
        </div>
        <span className="cd-house-rules__rule-actions">
          {end === 'change' ? <WordsShape words="Change" className="cd-button cd-button--secondary cd-button--inline cd-type-control" /> : null}
          {end === 'always' ? (
            <WordsShape words="Always on" className="cd-house-rules__always-on cd-type-meta"><Icon name="lock" size={14} /></WordsShape>
          ) : (
            <>
              <Skeleton shape="block" width="var(--size-dot)" height="var(--size-dot)" radius="full" />
              {details ? <DetailsSpace /> : null}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** A section's header: its title, and its caption at the right or under it. */
function SectionShape({ title, caption, anchor }: { title: string; caption: string; anchor: string }) {
  return (
    <div className="cd-section-header" data-skeleton-anchor={anchor}>
      <div className="cd-section-header__title">
        <Lines precise fitted words={title} className="cd-section-header__heading cd-type-section" text="section" />
      </div>
      <Lines precise fitted words={caption} className="cd-section-header__caption cd-type-meta" text="meta" />
    </div>
  );
}

const neverMovesMoney = ALWAYS_ON_SENTENCES.find((rule) => rule.key === 'money');

/** What a tools view's shapes are drawn from, and how the page that waits for it draws its rules. */
export interface ToolRulesShapesProps {
  /** A sample of the page's tools and cards, worded by the page's own model (`toolGroups`). */
  sample: ToolsView;
  /** The payment limit the money rules are worded at. */
  cap: number;
  /** The "Tool by tool" header's caption: Rules' or setup's. */
  toolsCaption: string;
  /** The version line under the tools; none in setup, whose draft has no version to name. */
  version: number | null;
  /** Setup's Your rules: no Details and no "Change". */
  readOnly: boolean;
  /** The class of the shapes' box, which sets the gap between its sections as the page does. */
  className: string;
}

/**
 * "Across your Desk", then the sample's tools, tool by tool, as the tools view (`ToolConnectors`)
 * draws them: Rules' shapes, and setup's Your rules', which are read only.
 */
export function ToolRulesShapes({ sample, cap, toolsCaption, version, readOnly, className }: ToolRulesShapesProps) {
  const root = useRef<HTMLDivElement>(null);
  const lines = useShapeLines(root);
  const details = !readOnly;
  return (
    <ShapeLines.Provider value={lines}>
      <div ref={root} className={className}>
        <div className="cd-rules__section">
          <SectionShape title={RULES_SECTIONS.across.title} caption={RULES_SECTIONS.across.caption} anchor="rules-across-header" />
          <SkeletonCard padding={0} anchor="rules-across">
            <div className="cd-house-rules__rules cd-house-rules__rules--card">
              {ACROSS_DESK_SENTENCES.map((rule) => <RuleShape key={rule.key} id={`across:${rule.key}`} parts={rule.parts} {...(rule.line === undefined ? {} : { line: rule.line })} end="always" />)}
              <RuleShape id="across:fallback" parts={[{ text: RULES_FALLBACK }]} end="dot" details={false} />
            </div>
          </SkeletonCard>
        </div>
        <div className="cd-rules__section">
          <SectionShape title={RULES_SECTIONS.tools.title} caption={toolsCaption} anchor="rules-tools-header" />
          <div className="cd-rules__tool-cards">
            {toolGroups(sample, null).map((group, index) => (
              <SkeletonCard key={group.key} padding={0} anchor={index === 0 ? 'rules-first-card' : `rules-card-${index}`}>
                <div className="cd-house-rules__connector">
                  <div className="cd-house-rules__connector-header">
                    {group.connector === null && group.key !== 'jobs' ? null : <Skeleton shape="block" className="cd-connector-icon cd-connector-icon--section" />}
                    <div className="cd-house-rules__identity">
                      <div className="cd-house-rules__jobs-name cd-type-section"><Skeleton shape="line" text="section" width="40%" /></div>
                      {group.line === '' ? null : <TextShape id={`${group.key}:line`} parts={[group.line]} className="cd-house-rules__identity-line cd-type-meta" text="meta" />}
                    </div>
                  </div>
                  {group.money ? (
                    <div className="cd-house-rules__money">
                      <div className="cd-house-rules__rules cd-house-rules__rules--band">
                        <RuleShape id={`${group.key}:cap`} parts={moneyCapBandSentence(cap)} line={listWords(moneyTitles(group, sample))} end={readOnly ? 'dot' : 'change'} details={details} />
                        {neverMovesMoney === undefined ? null : <RuleShape id={`${group.key}:money`} parts={neverMovesMoney.parts} line={listWords(moneyTitles(group, sample))} end="always" />}
                      </div>
                    </div>
                  ) : null}
                  {group.entries.map((entry) => (
                    <div key={entry.row.tool} className="cd-house-rules__tool">
                      <div className="cd-house-rules__tool-header">
                        <div className="cd-house-rules__tool-text">
                          <div className="cd-house-rules__tool-title">
                            <div className="cd-house-rules__tool-heading cd-type-section"><Skeleton shape="line" text="section" width={160} /></div>
                          </div>
                          {entry.description === '' ? null : <TextShape id={`${entry.row.tool}:description`} parts={[entry.description]} className="cd-house-rules__tool-description cd-type-meta" text="meta" />}
                        </div>
                        {details ? <DetailsSpace /> : null}
                      </div>
                      <div className="cd-house-rules__rules">
                        {entry.rules.map((rule) => <RuleShape key={rule.card.card_id} id={`${entry.row.tool}:${rule.card.card_id}`} parts={rule.parts} line={rule.line} end="dot" details={details} />)}
                        {entry.always === undefined ? null : <RuleShape id={`${entry.row.tool}:always`} parts={entry.always.parts} end="always" />}
                        {/* A money job ends its list with its own money rules, as the tools view draws them. */}
                        {group.money || !entry.row.effects.some((effect) => MONEY_EFFECTS.has(effect)) ? null : (
                          <>
                            <RuleShape id={`${entry.row.tool}:cap`} parts={moneyCapSentence(cap)} end="dot" details={details} />
                            {neverMovesMoney === undefined ? null : <RuleShape id={`${entry.row.tool}:money`} parts={neverMovesMoney.parts} end="always" />}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {/* "Other tools"' rules that cover no tool on the page, under no tool's title. */}
                  {group.loose.length === 0 ? null : (
                    <div className="cd-house-rules__tool">
                      <div className="cd-house-rules__rules cd-house-rules__rules--loose">
                        {group.loose.map((rule) => <RuleShape key={rule.card.card_id} id={`loose:${rule.card.card_id}`} parts={rule.parts} line={rule.line} end="dot" details={details} />)}
                      </div>
                    </div>
                  )}
                </div>
              </SkeletonCard>
            ))}
          </div>
          {version === null ? null : <TextShape id="version" parts={[rulesVersionLine(version)]} className="cd-rules__version cd-type-meta" text="meta" anchor="rules-version" />}
        </div>
      </div>
    </ShapeLines.Provider>
  );
}

/** Rules' own layout; the reload additionally draws its header, composer and chips. */
export function RulesSkeleton({ withHeader }: { withHeader: boolean }) {
  return (
    <div className="cd-rules">
      {withHeader ? <Header /> : null}
      <ToolRulesShapes sample={SAMPLE} cap={50_000} toolsCaption={RULES_SECTIONS.tools.caption} version={7} readOnly={false} className="cd-rules-skeleton__body" />
    </div>
  );
}
