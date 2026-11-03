import { useId } from 'react';

import { EmptyState, TextLink } from '../ds/index.ts';
import { StandalonePage } from './StandalonePage.tsx';

/**
 * What an owner page throws when its address names a record its copy doesn't hold and it learns so
 * only from a list it reads, such as a person on Customers. The route's error element answers it
 * with the not-found screen in place of the owner frame, as the frame itself does for a Desk
 * outside the copy.
 */
export class OutsideTheCopy extends Error {
  constructor() {
    super('The address names a record outside this copy.');
    this.name = 'OutsideTheCopy';
  }
}

/** A path the app doesn't know, or a record outside this demo copy: what happened and a way back. */
export function NotFound({ visitor = false }: { visitor?: boolean }) {
  const titleId = useId();
  return (
    <StandalonePage labelledBy={titleId} homeHref={visitor ? undefined : '/'}>
      <EmptyState
        title={<span id={titleId}>This page doesn't exist</span>}
        body={
          <>
            Check the link, or <TextLink href="/" runningText>start again from the home page</TextLink>.
          </>
        }
      />
    </StandalonePage>
  );
}
