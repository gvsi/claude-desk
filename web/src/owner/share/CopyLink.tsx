import { useRef, type ReactNode } from 'react';

import { Button, CopyField, copyResultLine, useCopyText } from '../../ds/index.ts';
import { displayLink } from './shareCopy.ts';

import './CopyLink.css';

export interface CopyLinkProps {
  /** The Desk's public link, as the API gave it. */
  url: string;
  /** More buttons on the link's line after "Copy link": the setup live step's "Open". */
  actions?: ReactNode;
  /**
   * How the link shows. `field` (the default): whole, in the design system's copy field, with a
   * secondary "Copy link", as the setup live step's board draws it. `text`: as people type it, in
   * section type, with "Copy link" the page's one primary button, as Share's board draws it.
   */
  look?: 'field' | 'text';
}

/** Writes the link to the clipboard; a browser without one, or one that refuses, throws. */
async function writeToClipboard(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

/**
 * The Desk's public link with "Copy link", which copies the whole link through `useCopyText`, so a
 * copy that didn't work selects the link as shown and says so ("Copy didn't work. The link is
 * selected, so copy it yourself."). Used on the setup live step, Today and Share.
 */
export function CopyLink({ url, actions, look = 'field' }: CopyLinkProps) {
  const field = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const { state, announcement, copy } = useCopyText(writeToClipboard);
  const result = copyResultLine(state, { what: 'link' });
  const target = () => (look === 'text' ? text.current : (field.current?.querySelector<HTMLElement>('[data-copy="code"]') ?? null));
  return (
    <div className={`cd-copy-link cd-copy-link--${look}`}>
      <div className="cd-copy-link__row">
        {look === 'text' ? (
          <p ref={text} className="cd-copy-link__text cd-type-section" data-copy="user">
            {displayLink(url)}
          </p>
        ) : (
          <div ref={field} className="cd-copy-link__field">
            <CopyField value={url} language="en" />
          </div>
        )}
        <Button variant={look === 'text' ? 'primary' : 'secondary'} size="main" onClick={() => void copy(url, target())}>
          Copy link
        </Button>
        {actions}
      </div>
      {/* Always there, so the line after a press is read out when it appears. */}
      <p role="status" className="cd-copy-link__result cd-type-meta">
        {result === '' ? null : <span key={announcement}>{result}</span>}
      </p>
    </div>
  );
}
