import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Skeleton, SkeletonCard, type SkeletonText } from '../../ds/index.ts';
import { useTextLines, type TextPart } from '../../lib/useTextLines.ts';
import { greetingFor } from '../../lib/format.ts';
import { THINGS_TO_TRY } from '../arrival/ideas.ts';
import { doneCaption } from '../arrival/doneSignals.ts';
import { publicLink } from '../customerLink.ts';

import './Today.css';

const BUTTON = 'cd-button cd-button--secondary cd-button--inline cd-type-control';

// Decision 15: these are the fresh copy's words, used only in invisible measurement probes.
// A different Desk's names, request, rule or recorded activity may land with one accepted move.
const DETAILS = [
  'Your public page opens in a new tab. Ask about a price or a time.',
  "Ask for a discount, another customer's address or Maria's home number. Safety shows what was refused and why.",
  'A request is waiting for your answer. Held by your rule: Quotes from your price list, at list price.',
  'Describe a business in a few sentences. Claude drafts the rules, and you confirm them.',
] as const;

/** Intrinsic grid/flex columns take the words' width in the real font, rather than a pill's width. */
function useWordWidth(box: RefObject<HTMLElement | null>, words: string | readonly TextPart[], className: string, intrinsic: boolean) {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !intrinsic || typeof words !== 'string') return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected) return;
      const probe = document.createElement('span');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', display: 'block', width: 'max-content', maxWidth: 'none' });
      probe.textContent = words;
      element.append(probe);
      // Text probes use clientWidth; round up so a fractional intrinsic width doesn't add a line.
      try { setWidth(Math.ceil(probe.getBoundingClientRect().width)); }
      finally { probe.remove(); }
    };
    measure();
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; document.fonts.removeEventListener('loadingdone', measure); };
  }, [box, words, className, intrinsic]);
  return intrinsic ? width : undefined;
}

/** Measure known words in their real type and wrapping rules, without leaving words in the layer. */
function TextLines({ words, text = 'meta', className = '', probeClassName = className, anchor, intrinsic = false }: {
  words: string | readonly TextPart[]; text?: SkeletonText; className?: string; probeClassName?: string; anchor?: string; intrinsic?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const width = useWordWidth(box, words, `${probeClassName} cd-type-${text}`, intrinsic);
  const count = useTextLines(box, {
    parts: typeof words === 'string' ? [words] : words,
    className: `${probeClassName} cd-type-${text}`,
  }, 1);
  return (
    <span ref={box} className={`${className} cd-today-skeleton__text`} style={width === undefined ? undefined : { width }} data-skeleton-anchor={anchor}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === count - 1 ? '75%' : '100%'} />
      ))}
    </span>
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
              <TextLines words={`${greetingFor(new Date(), 'America/Los_Angeles')}, Maria`} text="greeting" probeClassName="cd-greeting__title" anchor="greeting" intrinsic />
              <div className="cd-greeting__presence">
                <span className="cd-greeting__glyphs">
                  <Skeleton shape="block" radius="full" width="calc(var(--size-avatar) - var(--space-6))" height="calc(var(--size-avatar) - var(--space-6))" />
                </span>
                <TextLines words="One person is talking to your Desk right now." text="body" intrinsic />
              </div>
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
            <TextLines words="Things to try" text="section" className="cd-things__title" anchor="things-title" intrinsic />
            <TextLines words={doneCaption(0)} className="cd-things__caption" />
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
                    <TextLines words={THINGS_TO_TRY[i]!.title} text="control" className="cd-things__item-title" />
                    <TextLines words={DETAILS[i]!} className="cd-things__detail" />
                  </div>
                  <div className="cd-things__action">
                    <Skeleton shape="block" measure={{ label, className: BUTTON, tagName: i === 0 || i === 3 ? 'a' : 'button' }} height="var(--size-control)" anchor={`thing-action-${i}`} />
                  </div>
                </div>
              ))}
            </div>
          </SkeletonCard>
          <TextLines words="Vision: where a Desk could go next" className="cd-things__vision" />
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="needs-title" />
          <SkeletonCard anchor="held-card">
            <div className="cd-approval-card__top">
              <Skeleton shape="line" text="caption" width="80%" />
            </div>
            <TextLines words="A visitor not on record asked for a drain clearing quote at 15% off, $153.00 instead of $180.00." text="summary" className="cd-approval-card__reason" />
            <TextLines words="From the visitor: “How much to clear a clogged drain? Can I get 15% off if I pay cash?”" className="cd-approval-card__context" />
            <div className="cd-approval-card__held-by">
              <Skeleton shape="block" width={16} height={16} />
              <TextLines words="Held by your rule: Quotes from your price list, at list price." className="cd-today-skeleton__rule" />
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
                          <TextLines words="Dana Whitfield" />
                          <TextLines words="A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours." className="cd-briefing-row__line" />
                        </>
                      ) : (
                        <TextLines words={['Claude answered ', { text: "Alex Kim's assistant", className: 'cd-user-name' }, '.']} className="cd-briefing-row__line" />
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
            <TextLines words={publicLink('rivera-plumbing-abc123')} className="cd-today-aside__link" />
            <TextLines words="Chats on it are real conversations with your Desk. They show up in Conversations." className="cd-today-aside__text" />
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
              <TextLines words="Handled by Claude, or by you" text="control" className="cd-week__title" />
              <Skeleton shape="block" height="var(--space-6)" />
              <TextLines words="Claude handled 2 You stepped in 1 time" className="cd-week__legend" />
            </div>
            <div className="cd-week__part">
              <Skeleton shape="line" text="control" width="70%" />
              <TextLines words="Nothing turned down in the last 7 days." className="cd-week__line" />
              <Skeleton shape="line" text="meta" width="30%" />
            </div>
          </div>
        </SkeletonCard>
      </div>
    </div>
  );
}
