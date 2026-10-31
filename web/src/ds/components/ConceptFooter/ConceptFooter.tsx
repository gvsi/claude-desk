import { Mark } from '../Mark/Mark.tsx';

import './ConceptFooter.css';

export interface ConceptFooterProps {
  /** Adds "Powered by Claude Desk" with the mark, for the public page. */
  poweredBy?: boolean;
}

/**
 * The line every surface carries, word for word. The copy check reads `[data-ds="concept-footer"]`
 * against its own copy of the text, so a change here fails every story that shows the footer. It is
 * English on every page, a Spanish visitor's too, and says so (`lang="en"`), so a screen reader
 * doesn't read it with the page's Spanish voice.
 */
export function ConceptFooter({ poweredBy = false }: ConceptFooterProps) {
  return (
    <div className="cd-concept-footer" lang="en">
      <p className="cd-concept-footer__text cd-type-caption" data-ds="concept-footer">
        Concept prototype by Giovanni Alcantara, not an Anthropic product
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
