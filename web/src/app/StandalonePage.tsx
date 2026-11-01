import type { ReactNode } from 'react';

import { ConceptFooter, Mark, Wordmark } from '../ds/index.ts';

import './StandalonePage.css';

export interface StandalonePageProps {
  /** The id of what names the page's main region. */
  labelledBy: string;
  /** The language of the page's words, when it isn't the document's. */
  lang?: string;
  /**
   * The ground the page is drawn on: the app's dark one (the default), or a light one, such as the About set's
   * paper, where the bell keeps the drawing's dark ink.
   */
  ground?: 'dark' | 'light';
  children: ReactNode;
}

/**
 * A page outside the owner app and the public page, such as an unknown path or a page that broke:
 * the product's name at the top, one state in the middle of the window, and the concept footer.
 */
export function StandalonePage({ labelledBy, lang, ground = 'dark', children }: StandalonePageProps) {
  return (
    <div className="cd-standalone-page" lang={lang}>
      <header className="cd-standalone-page__brand">
        <Mark ground={ground} />
        <Wordmark />
      </header>
      <main className="cd-standalone-page__main" aria-labelledby={labelledBy}>
        {children}
      </main>
      <footer className="cd-standalone-page__footer">
        <ConceptFooter />
      </footer>
    </div>
  );
}
