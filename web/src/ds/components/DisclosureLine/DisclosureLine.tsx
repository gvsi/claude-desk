import type { ReactNode } from 'react';

import type { CopyLanguage } from '../Notice/errorCopy.ts';

import './DisclosureLine.css';

/**
 * The line's words, fixed at build time in both languages a visitor reads: with the business's
 * name where the page has one, and without it where it doesn't, as on the checkout.
 */
const DISCLOSURE_COPY = {
  en: {
    withName: (name: ReactNode) => <>{name} answers with Claude, an AI.</>,
    withoutName: 'This page is part of a chat with Claude, an AI.',
  },
  es: {
    withName: (name: ReactNode) => <>{name} responde con Claude, una IA.</>,
    withoutName: 'Esta página es parte de un chat con Claude, una IA.',
  },
} as const satisfies Record<CopyLanguage, { withName: (name: ReactNode) => ReactNode; withoutName: string }>;

export interface DisclosureLineProps {
  /** The page's language. The line sets `lang` to it. */
  language: CopyLanguage;
  /** The business the page belongs to (`PublicDesk.business_name`). Leave it out on the checkout. */
  businessName?: string;
}

/**
 * The AI disclosure on a visitor page that isn't the chat itself: one quiet line in the page's
 * language, never hidden and never dismissable. It says the page answers with Claude, an AI.
 */
export function DisclosureLine({ language, businessName }: DisclosureLineProps) {
  const copy = DISCLOSURE_COPY[language];
  // A blank name says nothing, so the line falls back to the words without one: it never shows
  // "answers with Claude" with no one before it.
  const name = businessName?.trim();
  return (
    <p className="cd-disclosure-line cd-type-meta" lang={language}>
      {name ? copy.withName(<span data-copy="user">{name}</span>) : copy.withoutName}
    </p>
  );
}
