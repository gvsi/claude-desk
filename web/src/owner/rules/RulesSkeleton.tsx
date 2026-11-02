import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { Skeleton, SkeletonCard, type SkeletonText } from '../../ds/index.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { useTextBox, useTextLines } from '../../lib/useTextLines.ts';
import { COMPOSER_HELPER, RULES_CHIPS, RULES_SUBTITLE, RULES_FALLBACK } from './copy.ts';
import { rulesGroups } from './hub.ts';
import type { RuleCard } from '../../api/contracts.ts';
import type { TextPart } from '../../lib/useTextLines.ts';

import './RulesPage.css';

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

function Lines({
  words,
  className,
  text = 'body',
  anchor,
  fitted = false,
  parts,
}: {
  words: string;
  className: string;
  text?: SkeletonText;
  anchor?: string;
  fitted?: boolean;
  parts?: readonly TextPart[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(box, fitted ? { label: words, className, tagName: 'span' } : undefined);
  const count = useTextLines(box, { parts: parts ?? [words], className }, 1);
  return (
    <div ref={box} className={className} style={fitted && width !== undefined ? { width: Math.ceil(width) } : undefined} data-skeleton-anchor={anchor}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i ? '70%' : '100%'} />
      ))}
    </div>
  );
}

/** A control's own styles determine both its height and its label width. */
function Control({ label, className, anchor, suffix = false }: { label: string; className: string; anchor?: string; suffix?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = {
    label,
    className,
    tagName: className.includes('cd-text-link') ? ('a' as const) : ('button' as const),
    ...(suffix
      ? {
          suffix: {
            className: 'cd-rules-skeleton__suffix',
            width: 'var(--space-16)',
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
            <span className="cd-type-control">
              <Control label="See all rules" className="cd-text-link cd-type-control" anchor="rules-header-all" />
            </span>
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

/** Representative first-load rows, worded by the same model as the page, never policy data. */
const sampleCard = (target: RuleCard['applies_to']): RuleCard => ({
  ...rivera.ruleCards['rv-quote'], card_id: `shape:${target}`, applies_to: target,
});
const SAMPLE_GROUPS = rulesGroups({
  active: {
    auto_money_cap_cents: 50_000,
    cards: [...Object.values(rivera.ruleCards), ...[
      'native.find_slots', 'native.capture_lead', 'native.request_callback', 'desk.emergency-callback',
    ].map(sampleCard)],
  },
  tools: [
    { tool: 'native.payment_link', source: 'native', effects: ['charge'] },
    { tool: 'native.charge_mandate', source: 'native', effects: ['charge'] },
    { tool: 'payments.create_refund', source: 'mcp', effects: ['pay_out', 'private_data'] },
    { tool: 'desk.emergency-callback', source: 'business', effects: ['change'], business: {
      title: 'Emergency callback', description: '', config: { block: 'urgent', urgent_when: '' },
    } },
  ],
}, null);

function Body() {
  return (
    <>
      <div className="cd-rules__groups">
        <SkeletonCard anchor="rules-card">
          {SAMPLE_GROUPS.map((group) => (
            <div key={group.mode} className="cd-rules__group">
              <div className="cd-rules__group-title cd-type-section" data-skeleton-anchor={`rules-group-${group.mode}`}>
                <Skeleton shape="block" width="var(--size-dot)" height="var(--size-dot)" radius="full" />
                <Lines words={group.title} fitted className="cd-type-section" text="section" />
              </div>
              <div className="cd-rules__rows">
                {group.rows.map((row) => {
                  const titles = typeof row.meta.tools === 'string' ? [row.meta.tools] : row.meta.tools.titles;
                  const parts: TextPart[] = titles.flatMap((text, i) => [
                    ...(i === 0 ? [] : [i === titles.length - 1 ? ' and ' : ', ']),
                    { text, className: 'cd-user-name' },
                  ]);
                  parts.push(` · ${row.meta.who}`);
                  return (
                    <div key={row.key} className="cd-rules__row">
                      <div className="cd-rule-sentence">
                        <div className="cd-rule-sentence__layout">
                          <div className="cd-rule-sentence__text">
                            <Lines words={row.parts.map((part) => part.text).join('')}
                              parts={row.parts.map((part) => part.key ? { text: part.text, className: 'cd-rule-sentence__key' } : part.text)}
                              className="cd-rule-sentence__sentence cd-type-body" />
                            <Lines words="" parts={parts} className="cd-rule-sentence__meta cd-type-meta" text="meta" />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </SkeletonCard>
      </div>
      <Lines words={RULES_FALLBACK} className="cd-rules__fallback cd-type-meta" text="meta" anchor="rules-fallback" />
    </>
  );
}

/** Rules' own layout; the reload additionally draws its header, composer and chips. */
export function RulesSkeleton({ withHeader }: { withHeader: boolean }) {
  return (
    <div className="cd-rules">
      {withHeader ? <Header /> : null}
      <Body />
    </div>
  );
}
