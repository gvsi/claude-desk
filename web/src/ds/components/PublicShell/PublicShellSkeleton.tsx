import { useRef } from 'react';

import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Skeleton, SkeletonCard } from '../Skeleton/Skeleton.tsx';
import { PublicBrandHeaderSkeleton } from './PublicBrandHeaderSkeleton.tsx';
import { useShellLayout, useVisualViewportFit } from './PublicShell.tsx';

import './PublicShell.css';

/** The shell's own layout and measurements, with no visitor content or interactive elements. */
export function PublicShellSkeleton({ language, footer }: { language: CopyLanguage; footer: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  useVisualViewportFit(shell, !footer);
  const aboutBeside = useShellLayout(shell);
  const about = footer ? (
    <div className="cd-public-shell__about" data-skeleton-anchor="about-column">
      <Skeleton shape="line" text="section" width={200} anchor="about-title" />
      <div className="cd-public-shell__blocks">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonCard key={i} padding={16} className="cd-reply-card">
            <div className="cd-reply-card__label">
              <Skeleton shape="block" width={16} height={16} />
              <Skeleton shape="line" text="caption" width={70} />
            </div>
            <div className="cd-reply-card__data">
              <div className="cd-reply-card__headline">
                <Skeleton shape="line" text="section" />
                {i === 2 || i === 3 ? <Skeleton shape="line" text="section" width="75%" /> : null}
                {i === 0 || i === 3 ? <Skeleton shape="line" text="section" width="65%" className="cd-public-shell-skeleton__beside-line" /> : null}
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
    <div ref={shell} className={`cd-public-shell cd-public-shell--skeleton${footer ? '' : ' cd-public-shell--embedded'}`} lang={language}>
      <PublicBrandHeaderSkeleton hours />
      <div className="cd-public-shell__body">
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
            <Skeleton shape="block" width={language === 'es' ? 209 : 151} height="var(--size-control)" className="cd-public-shell-skeleton__ask" anchor="ask-owner" />
          </div>
          <div className="cd-public-shell__scroll">
            {aboutBeside ? null : about}
            <div className="cd-public-shell__conversation" data-skeleton-anchor="conversation" />
          </div>
          <div className="cd-public-shell__composer">
            <div className="cd-public-shell-skeleton__composer">
              <Skeleton shape="block" height="calc(var(--size-control) + 2 * var(--space-10))" radius="composer" anchor="composer" />
              <Skeleton shape="line" text="body" width="55%" className="cd-public-shell-skeleton__placeholder" />
            </div>
          </div>
          {footer ? (
            <div className="cd-public-shell__footer">
              <div data-skeleton-anchor="concept-footer"><ConceptFooter poweredBy /></div>
            </div>
          ) : null}
        </div>
        {aboutBeside ? about : null}
      </div>
    </div>
  );
}
