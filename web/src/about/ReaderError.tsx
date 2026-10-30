/**
 * What an About this prototype page shows when its document can't be read: one plain line and the way back
 * to the Desk, with the footer. It never names the error, and it imports neither the reader nor the
 * documents, so it draws when they can't load.
 */
import { useId } from 'react';

import { StandalonePage } from '../app/StandalonePage.tsx';
import { Notice } from '../ds/index.ts';
import { PrototypeLink } from './PrototypeLink.tsx';

export function ReaderError() {
  const titleId = useId();
  return (
    <StandalonePage labelledBy={titleId}>
      <h1 id={titleId} className="cd-sr-only">
        About this prototype
      </h1>
      <Notice tone="error" action={<PrototypeLink />}>
        This document can’t be shown right now. You can go back and try again later.
      </Notice>
    </StandalonePage>
  );
}
