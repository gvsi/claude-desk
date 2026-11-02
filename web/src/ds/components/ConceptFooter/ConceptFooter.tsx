import { Mark } from '../Mark/Mark.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';

import './ConceptFooter.css';

/** The prototype's author, named in the footer and in the About pages' bylines. */
export const AUTHOR_NAME = 'Giovanni Alcantara';

/** Where the author's name links: the author's LinkedIn profile, opened in a new tab. */
export const AUTHOR_URL = 'https://www.linkedin.com/in/giovannialcantara/';

export interface ConceptFooterProps {
  /** Adds "Powered by Claude Desk" with the mark, for the public page. */
  poweredBy?: boolean;
  /**
   * Inside a loading skeleton's hidden shapes: the name looks as it will once the page lands, but
   * isn't a link, since nothing in the shapes may take focus.
   */
  skeleton?: boolean;
}

/**
 * The line every surface carries, word for word. The copy check reads `[data-ds="concept-footer"]`
 * against its own copy of the text, so a change here fails every story that shows the footer. The
 * author's name links to the author's profile, in a new tab; the words stay the same. It is
 * English on every page, a Spanish visitor's too, and says so (`lang="en"`), so a screen reader
 * doesn't read it with the page's Spanish voice.
 */
export function ConceptFooter({ poweredBy = false, skeleton = false }: ConceptFooterProps) {
  return (
    <div className="cd-concept-footer" lang="en">
      <p className="cd-concept-footer__text cd-type-caption" data-ds="concept-footer">
        Concept prototype by{' '}
        {skeleton ? (
          <span className="cd-text-link cd-text-link--running-text">{AUTHOR_NAME}</span>
        ) : (
          <TextLink href={AUTHOR_URL} external runningText>
            {AUTHOR_NAME}
          </TextLink>
        )}
        , not an Anthropic product
      </p>
      {poweredBy ? (
        <p className="cd-concept-footer__powered cd-type-caption">
          <Mark size={16} />
          <span>
            Powered by <span className="cd-concept-footer__brand">Claude Desk</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}
