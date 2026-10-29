import { useId } from 'react';

import { ConceptFooter, EmptyState, Mark, TextLink, Wordmark } from '../ds/index.ts';

import './NotFound.css';

/** A path the app doesn't know, or a record outside this demo copy: what happened and a way back. */
export function NotFound() {
  const titleId = useId();
  return (
    <div className="cd-not-found">
      <header className="cd-not-found__brand">
        <Mark />
        <Wordmark />
      </header>
      <main className="cd-not-found__main" aria-labelledby={titleId}>
        <EmptyState
          title={<span id={titleId}>This page doesn't exist</span>}
          body={
            <>
              Check the link, or <TextLink href="/">start again from the home page</TextLink>.
            </>
          }
        />
      </main>
      <footer className="cd-not-found__footer">
        <ConceptFooter />
      </footer>
    </div>
  );
}
