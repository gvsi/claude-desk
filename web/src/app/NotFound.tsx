import { useId } from 'react';

import { EmptyState, TextLink } from '../ds/index.ts';
import { StandalonePage } from './StandalonePage.tsx';

/** A path the app doesn't know, or a record outside this demo copy: what happened and a way back. */
export function NotFound() {
  const titleId = useId();
  return (
    <StandalonePage labelledBy={titleId}>
      <EmptyState
        title={<span id={titleId}>This page doesn't exist</span>}
        body={
          <>
            Check the link, or <TextLink href="/">start again from the home page</TextLink>.
          </>
        }
      />
    </StandalonePage>
  );
}
