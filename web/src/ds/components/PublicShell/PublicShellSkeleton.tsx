import { useRef } from 'react';

import { useTextLines, type TextPart } from '../../../lib/useTextLines.ts';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Skeleton, SkeletonCard } from '../Skeleton/Skeleton.tsx';
import { PublicBrandHeaderSkeleton } from './PublicBrandHeaderSkeleton.tsx';
import { ASK_OWNER_PREFIX, useShellLayout, useVisualViewportFit } from './PublicShell.tsx';
import { useFirstView } from './useFirstView.ts';

import '../SuggestionChips/SuggestionChips.css';
import './PublicShell.css';

/** Three one-line starter chips, as wide as the fresh copy's, so they wrap as its do at 390 px. */
const CHIP_WIDTHS = [189, 201, 174] as const;

/** The invitation's meta line, as wide as its words in each language. */
const INVITATION_WIDTH: Record<CopyLanguage, number> = { en: 276, es: 322 };

/** The fresh disclosure's words, measured only, with the owner's name kept together as on the page. */
const DISCLOSURE: Record<CopyLanguage, readonly TextPart[]> = {
  en: ["You're chatting with Claude, an AI answering for Turner Plumbing. Ask for ", { text: 'Mike Turner', className: 'cd-public-shell__owner' }, ' anytime.'],
  es: ['Estás hablando con Claude, una IA que responde por Turner Plumbing. Puedes pedir hablar con ', { text: 'Mike Turner', className: 'cd-public-shell__owner' }, ' cuando quieras.'],
};

/** The fresh greeting's words, measured only, so its shape takes as many lines as they do. */
const GREETING: Record<CopyLanguage, string> = {
  en: 'How can Turner Plumbing help?',
  es: '¿En qué te puede ayudar Turner Plumbing?',
};

/** The fresh charter's card titles, measured only, so each card's shape takes as many lines as its words. */
const CARD_TITLES: Record<CopyLanguage, readonly string[]> = {
  en: [
    'Monday to Friday, 8:00 am to 6:00 pm',
    '(510) 555-0142',
    'We work in Oakland, Berkeley, Alameda and Emeryville.',
    'The service call deposit is credited to the repair if you go ahead.',
    'Mike texts before he arrives.',
  ],
  es: [
    'De lunes a viernes, de 8:00 a 18:00',
    '(510) 555-0142',
    'We work in Oakland, Berkeley, Alameda and Emeryville.',
    'The service call deposit is credited to the repair if you go ahead.',
    'Mike texts before he arrives.',
  ],
};

/** A wrapped line's width: each line shorter than the one before, down to the last width given. */
function lineWidth(widths: readonly string[], line: number): string | undefined {
  return widths[Math.min(line, widths.length - 1)];
}

/** A charter card's shape, its title as many lines as the fresh copy's take at the card's width. */
function AboutCardShape({ index, title, layoutKey }: { index: number; title: string; layoutKey: unknown }) {
  const headline = useRef<HTMLDivElement>(null);
  const lines = useTextLines(headline, { parts: [title], className: 'cd-reply-card__headline cd-type-section' }, 1, layoutKey);
  return (
    <SkeletonCard padding={16} className="cd-reply-card" anchor={`about-card-${index}`}>
      <div className="cd-reply-card__label">
        <Skeleton shape="block" width={16} height={16} />
        <Skeleton shape="line" text="caption" width={70} />
      </div>
      <div className="cd-reply-card__data">
        <div ref={headline} className="cd-reply-card__headline">
          {Array.from({ length: lines }, (_, line) => (
            <Skeleton key={line} shape="line" text="section" width={lineWidth(['100%', '75%', '65%'], line)} />
          ))}
        </div>
        {index === 0 ? <Skeleton shape="line" text="meta" width="85%" className="cd-reply-card__detail" /> : null}
      </div>
    </SkeletonCard>
  );
}

/**
 * The shell's own layout and measurements, with no visitor content or interactive elements. History
 * is unknown until the page lands, so every load draws the first view: the greeting, its meta line,
 * the composer and three starter chips, placed by the same hook as the real invitation.
 */
export function PublicShellSkeleton({ language, footer }: { language: CopyLanguage; footer: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  useVisualViewportFit(shell, !footer);
  const aboutBeside = useShellLayout(shell);
  const disclosure = useRef<HTMLDivElement>(null);
  const disclosureLines = useTextLines(disclosure, { parts: DISCLOSURE[language], className: 'cd-public-shell__disclosure cd-type-meta' }, 2, aboutBeside);
  const welcome = useRef<HTMLDivElement>(null);
  // In the greeting's type only: a probe with the greeting's own class would count as a greeting mounted.
  const greetingLines = useTextLines(welcome, { parts: [GREETING[language]], className: 'cd-type-greeting' }, 1, aboutBeside);
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
        {CARD_TITLES[language].map((title, i) => (
          <AboutCardShape key={i} index={i} title={title} layoutKey={aboutBeside} />
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
              <div ref={disclosure} data-skeleton-anchor="disclosure">
                {Array.from({ length: disclosureLines }, (_, i) => (
                  <Skeleton key={i} shape="line" text="meta" width={i === disclosureLines - 1 ? '80%' : '100%'} />
                ))}
              </div>
            </div>
            <Skeleton shape="block" measure={{ label: `${ASK_OWNER_PREFIX[language]}Mike Turner`, className: 'cd-button cd-button--secondary cd-button--inline cd-type-control' }} height="var(--size-control)" className="cd-public-shell-skeleton__ask" anchor="ask-owner" />
          </div>
          <div className="cd-public-shell__scroll">
            <div className="cd-public-shell__conversation" data-skeleton-anchor="conversation">
              <div ref={welcome} className="cd-public-shell__welcome">
                {Array.from({ length: greetingLines }, (_, line) => (
                  <Skeleton key={line} shape="line" text="greeting" width={lineWidth(['70%', '60%', '50%'], line)} anchor={line === 0 ? 'greeting' : undefined} />
                ))}
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
