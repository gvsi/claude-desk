import { useId } from 'react';
import { useRouteError } from 'react-router';

import { Button, Notice, UNREACHABLE_COPY } from '../ds/index.ts';
import { browserLanguage } from '../lib/language.ts';
import { PUBLIC_COPY } from '../public/copy.ts';
import { useDocumentLanguage } from '../public/useDocumentLanguage.ts';
import { NotFound, OutsideTheCopy } from './NotFound.tsx';
import { StandalonePage } from './StandalonePage.tsx';

export interface RouteErrorProps {
  /** A visitor's page: its words follow the browser's language, as the public page's do. */
  visitor?: boolean;
}

/**
 * What a route shows when its page throws while it draws: the design system's line for something
 * that went wrong on our side, and "Try again", which loads the page afresh. Never the error's
 * message or stack: neither helps a visitor or an owner, and both can name the app's insides. A
 * page whose address names a record outside the copy (`OutsideTheCopy`) gets the not-found screen.
 */
export function RouteError({ visitor = false }: RouteErrorProps) {
  const titleId = useId();
  const outsideTheCopy = useRouteError() instanceof OutsideTheCopy;
  // The not-found screen is English. A visitor's error line is in their language, and while it
  // shows, the whole document is too, as the page would have made it.
  const language = visitor && !outsideTheCopy ? browserLanguage() : 'en';
  useDocumentLanguage(language);
  if (outsideTheCopy) return <NotFound visitor={visitor} />;
  return (
    <StandalonePage labelledBy={titleId} lang={visitor ? language : undefined} homeHref={visitor ? undefined : '/'}>
      <h1 id={titleId} className="cd-sr-only">
        Claude Desk
      </h1>
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {PUBLIC_COPY[language].tryAgain}
          </Button>
        }
      >
        {UNREACHABLE_COPY[language]}
      </Notice>
    </StandalonePage>
  );
}
