/**
 * What an About this prototype page shows when it can't be drawn: one plain line and the link into the prototype
 * to the Desk, with the footer, on the set's paper, as the page itself would be. It never names the error, and it
 * imports neither the reader nor the documents, so it draws when they can't load. The line says what failed: a
 * document on the two reading pages, a page on the Vision article.
 */
import { useId } from 'react';

import { StandalonePage } from '../app/StandalonePage.tsx';
import { Notice } from '../ds/index.ts';
import { PrototypeLink } from './PrototypeLink.tsx';

import './paper.css';

export interface ReaderErrorProps {
  /** What the page is: one of the two documents (the default), or a page of its own, such as the Vision article. */
  kind?: 'document' | 'page';
}

export function ReaderError({ kind = 'document' }: ReaderErrorProps) {
  const titleId = useId();
  return (
    <div className="cd-about-paper cd-about-paper--app">
      <StandalonePage labelledBy={titleId} ground="light">
        <h1 id={titleId} className="cd-sr-only">
          About this prototype
        </h1>
        <Notice tone="error" action={<PrototypeLink />}>
          {`This ${kind} can’t be shown right now. You can go back and try again later.`}
        </Notice>
      </StandalonePage>
    </div>
  );
}
