import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { ALWAYS_ON, Skeleton, SkeletonCard, outcomePhrase, type SkeletonText } from '../../ds/index.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { useTextBox, useTextLines } from '../../lib/useTextLines.ts';
import { CONNECTOR_PAGES_BUILT } from '../connectors/pages.ts';
import { COMPOSER_HELPER, RULES_CHIPS, RULES_SUBTITLE, rulesVersionLine } from './copy.ts';
import { moneyLimitLine } from './ruleWords.ts';

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

/** Known copy is measured, never drawn: wrapping follows this column and this browser's fonts. */
function Lines({
  words,
  className,
  text = 'body',
  anchor,
  fitted = false,
}: {
  words: string;
  className: string;
  text?: SkeletonText;
  anchor?: string;
  fitted?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(box, fitted ? { label: words, className, tagName: 'span' } : undefined);
  const count = useTextLines(box, { parts: [words], className }, 1);
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

/** The status label is inline flex, so its line box includes the surrounding text baseline. */
function Outcome({ words }: { words: string }) {
  const box = useRef<HTMLDivElement>(null);
  const className = 'cd-connector-section__tool-outcome cd-type-meta';
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected) return;
      const probe = document.createElement('div');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, {
        position: 'absolute',
        visibility: 'hidden',
        width: 'max-content',
      });
      const label = document.createElement('span');
      label.className = 'cd-status-label';
      const dot = document.createElement('span');
      dot.className = 'cd-status-dot';
      label.append(dot, words);
      probe.append(label);
      element.append(probe);
      const { width, height } = probe.getBoundingClientRect();
      probe.remove();
      setSize({ width, height });
    };
    measure();
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [words]);
  return (
    <div ref={box} className={className}>
      <Skeleton shape="block" width={size?.width} height={size?.height} radius="full" />
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

/** A fresh copy has no suggestions: draw its connector groups and always-on rules. */
function Body() {
  return (
    <>
      <div className="cd-connector-list">
        <div className="cd-connector-list__body">
          <Lines words={rulesVersionLine(7)} className="cd-connector-list__summary cd-type-meta" text="meta" />
          <div className="cd-connector-list__items">
            {rivera.connectors.sections.map(({ connector, tools }, i) => (
              <SkeletonCard key={connector.id} padding={0}>
                <div className="cd-connector-section">
                  <div className="cd-connector-section__header" data-skeleton-anchor={`rules-connector-${i}`}>
                    <Skeleton shape="block" className="cd-connector-icon cd-connector-icon--section" />
                    <div className="cd-connector-section__identity">
                      <Skeleton shape="line" text="section" width="60%" />
                      <Lines words={connector.description} className="cd-connector-section__description cd-type-meta" text="meta" />
                    </div>
                    <Skeleton shape="line" text="meta" className="cd-connector-section__count" width={45} />
                    {CONNECTOR_PAGES_BUILT ? <Skeleton shape="block" className="cd-connector-section__chevron" width={16} height={16} /> : null}
                  </div>
                  {connector.id === 'payments' || connector.id === 'stripe' ? (
                    <div className="cd-connector-section__above">
                      <div className="cd-money-limit">
                        <div className="cd-money-limit__reading">
                          <Lines
                            words={moneyLimitLine(50_000)}
                            className="cd-money-limit__line cd-type-body"
                          />
                          <Control label="Change" className="cd-button cd-button--secondary cd-type-control" />
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <div className="cd-connector-section__tools">
                    {tools.map((tool, j) => (
                      <div
                        key={tool.key}
                        className={`cd-connector-section__tool${CONNECTOR_PAGES_BUILT ? '' : ' cd-connector-section__tool--plain'}`}
                        data-skeleton-anchor={`rules-tool-${i}-${j}`}
                      >
                        <Lines words={tool.name} className="cd-connector-section__tool-name cd-type-body" />
                        <Lines words={tool.description} className="cd-connector-section__tool-description cd-type-meta" text="meta" />
                        <Lines
                          fitted
                          words={
                            tool.key === 'native.payment_link'
                              ? 'Anyone · Up to $300 · Checked by the reviewer'
                              : tool.key === 'native.charge_mandate'
                                ? 'Signed agents · Up to $20'
                                : tool.summary
                          }
                          className="cd-connector-section__tool-summary cd-type-meta"
                          text="meta"
                        />
                        <Outcome words={outcomePhrase(tool.mode, 'limit' in tool ? tool.limit : undefined)} />
                        {CONNECTOR_PAGES_BUILT ? <Skeleton shape="block" className="cd-connector-section__chevron" width={16} height={16} /> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </SkeletonCard>
            ))}
          </div>
        </div>
      </div>
      <div className="cd-rules__all cd-type-meta" data-skeleton-anchor="rules-all">
        <Skeleton shape="line" text="meta" width={90} />
      </div>
      <div className="cd-rules__always-on">
        <div className="cd-always-on">
          <div className="cd-section-header">
            <div className="cd-section-header__title">
              <Skeleton shape="line" text="section" width={90} anchor="rules-always" />
            </div>
            <Lines
              fitted
              words="On every Desk, whatever is connected. They can't be turned off."
              className="cd-section-header__caption cd-type-meta"
              text="meta"
            />
          </div>
          <div className="cd-always-on__list">
            {ALWAYS_ON.map((words) => (
              <div key={words} className="cd-always-on__item cd-type-body">
                <Skeleton shape="block" width={14} height="1lh" className="cd-always-on__lock" />
                <Lines words={words} className="cd-type-body cd-rules-skeleton__rule" />
              </div>
            ))}
          </div>
        </div>
        <div className="cd-rules__safety cd-type-meta">
          <Skeleton shape="line" text="meta" width={80} />
        </div>
      </div>
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
