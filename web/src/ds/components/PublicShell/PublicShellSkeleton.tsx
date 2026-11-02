import { useRef } from 'react';

import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Skeleton, SkeletonCard } from '../Skeleton/Skeleton.tsx';
import { PublicBrandHeaderSkeleton } from './PublicBrandHeaderSkeleton.tsx';
import { ASK_OWNER_PREFIX, useShellLayout, useVisualViewportFit } from './PublicShell.tsx';
import { useFirstView } from './useFirstView.ts';

import '../SuggestionChips/SuggestionChips.css';
import './PublicShell.css';

/** Three one-line starter chips, as wide as the fresh copy's, so they wrap as its do at 390 px. */
const CHIP_WIDTHS = [177, 186, 163] as const;

/** The invitation's meta line, as wide as its words in each language. */
const INVITATION_WIDTH: Record<CopyLanguage, number> = { en: 250, es: 287 };

/**
 * The shell's own layout and measurements, with no visitor content or interactive elements. History
 * is unknown until the page lands, so every load draws the first view: the greeting, its meta line,
 * the composer and three starter chips, placed by the same hook as the real invitation.
 */
export function PublicShellSkeleton({ language, footer }: { language: CopyLanguage; footer: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  useVisualViewportFit(shell, !footer);
  const aboutBeside = useShellLayout(shell);
  useFirstView(shell, true, aboutBeside, CHIP_WIDTHS.length);
  const about = footer ? (
    <div className="cd-public-shell__about" data-skeleton-anchor="about-column">
      {/* Keep the title's line box when a tall charter makes the column scroll. */}
      <div className="cd-public-shell__heading">
        <Skeleton shape="line" text="section" width={200} anchor="about-title" />
      </div>
      {aboutBeside ? (
        <div className="cd-public-shell__open-status" data-skeleton-anchor="about-status">
          <Skeleton shape="line" text="meta" width={170} />
        </div>
      ) : null}
      <div className="cd-public-shell__blocks">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonCard key={i} padding={16} className="cd-reply-card" anchor={`about-card-${i}`}>
            <div className="cd-reply-card__label">
              <Skeleton shape="block" width={16} height={16} />
              <Skeleton shape="line" text="caption" width={70} />
            </div>
            <div className="cd-reply-card__data">
              <div className="cd-reply-card__headline">
                <Skeleton shape="line" text="section" />
                {i === 2 || i === 3 ? <Skeleton shape="line" text="section" width="75%" /> : null}
                {i === 0 || i === 3 ? <Skeleton shape="line" text="section" width="65%" className={`cd-public-shell-skeleton__beside-line cd-public-shell-skeleton__${i === 0 ? 'hours' : 'deposit'}-wrap`} /> : null}
              </div>
              {i === 0 ? <Skeleton shape="line" text="meta" width="85%" className="cd-reply-card__detail" /> : null}
            </div>
          </SkeletonCard>
        ))}
      </div>
      <div className="cd-public-shell__links">
        <Skeleton shape="line" text="meta" width={100} />
        <div className="cd-public-shell__link-list">
          <Skeleton shape="line" text="body" width={130} />
          <Skeleton shape="line" text="body" width={170} />
        </div>
      </div>
    </div>
  ) : null;
  return (
    <div ref={shell} className={`cd-public-shell cd-public-shell--skeleton cd-public-shell--first-view${footer ? '' : ' cd-public-shell--embedded'}`} lang={language}>
      <PublicBrandHeaderSkeleton hours={!aboutBeside || !footer} />
      <div className="cd-public-shell__body">
        {aboutBeside ? about : null}
        <div className="cd-public-shell__chat">
          <div className="cd-public-shell__chat-head" data-skeleton-anchor="chat-head">
            <div className="cd-public-shell__chat-title">
              <Skeleton shape="line" text="section" width={230} anchor="chat-title" />
              <div data-skeleton-anchor="disclosure">
                <Skeleton shape="line" text="meta" />
                <Skeleton shape="line" text="meta" width="80%" className={language === 'en' && !footer ? 'cd-public-shell-skeleton__phone-line' : undefined} />
                {language === 'es' ? <Skeleton shape="line" text="meta" width="65%" className="cd-public-shell-skeleton__phone-line" /> : null}
              </div>
            </div>
            <Skeleton shape="block" measure={{ label: `${ASK_OWNER_PREFIX[language]}Mike Turner`, className: 'cd-button cd-button--secondary cd-button--inline cd-type-control' }} height="var(--size-control)" className="cd-public-shell-skeleton__ask" anchor="ask-owner" />
          </div>
          <div className="cd-public-shell__scroll">
            <div className="cd-public-shell__conversation" data-skeleton-anchor="conversation">
              <div className="cd-public-shell__welcome">
                <Skeleton shape="line" text="greeting" width="70%" anchor="greeting" />
                <Skeleton shape="line" text="greeting" width="60%" className="cd-public-shell-skeleton__phone-line" />
                <Skeleton shape="line" text="meta" width={INVITATION_WIDTH[language]} className="cd-public-shell__invitation" anchor="invitation" />
              </div>
            </div>
          </div>
          <div className="cd-public-shell__composer">
            <div className="cd-public-shell__composer-group">
              <div className="cd-public-shell__composer-lift">
                <div className="cd-public-shell-skeleton__composer">
                  <Skeleton shape="block" height="calc(var(--size-control) + 2 * var(--space-10))" radius="composer" anchor="composer" />
                  <Skeleton shape="line" text="body" width="55%" className="cd-public-shell-skeleton__placeholder" />
                </div>
              </div>
              <div className="cd-public-shell__starters" data-skeleton-anchor="starters">
                <div className="cd-suggestion-chips">
                  {CHIP_WIDTHS.map((width, i) => (
                    <Skeleton key={i} shape="block" width={width} height="var(--space-28)" radius="full" />
                  ))}
                </div>
              </div>
            </div>
          </div>
          {footer ? (
            <div className="cd-public-shell__footer">
              <div data-skeleton-anchor="concept-footer"><ConceptFooter poweredBy skeleton /></div>
            </div>
          ) : null}
          {aboutBeside ? null : about}
        </div>
      </div>
    </div>
  );
}
