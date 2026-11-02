/**
 * The capability prediction's claim, set as a card at the top of its first section so it doesn't read as a wall of
 * text: the document's own lead, list and caveat, which the page passes in as the article draws them, then the
 * prediction at a glance (`forecast.ts`) in a label column and a value column between hairlines.
 */
import type { ReactNode } from 'react';

import { TextLink } from '../../ds/index.ts';
import { GLANCE } from '../forecast.ts';

import '../reader.css';

export interface ClaimCardProps {
  /** The claim's blocks from the document, as the article renders them. */
  children: ReactNode;
  /** The phone layout: tighter padding and a narrower label column. */
  compact?: boolean;
}

export function ClaimCard({ children, compact = false }: ClaimCardProps) {
  return (
    <div className={`cd-about-frame cd-about-claim${compact ? ' cd-about-claim--compact' : ''}`} data-claim="">
      {children}
      <dl className="cd-about-claim__glance cd-type-body">
        {GLANCE.map(({ label, text, link }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {text}
              {link ? (
                <>
                  {' '}
                  <span className="cd-about-nowrap">
                    <TextLink href={link.href} external>
                      {link.text}
                    </TextLink>
                  </span>
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
