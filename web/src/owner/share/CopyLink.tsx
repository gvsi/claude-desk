import { useRef, type ReactNode } from 'react';

import { Button, CopyField, copyResultLine, useCopyText } from '../../ds/index.ts';

import './CopyLink.css';

export interface CopyLinkProps {
  /** The Desk's public link, as the API gave it. */
  url: string;
  /** More buttons on the link's line after "Copy link": the setup live step's "Open". */
  actions?: ReactNode;
}

/** Writes the link to the clipboard; a browser without one, or one that refuses, throws. */
async function writeToClipboard(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

/**
 * The Desk's public link with "Copy link": the link in the design system's copy field, and the
 * copy through `useCopyText`, so a copy that didn't work selects the link and says so ("Copy didn't
 * work. The link is selected, so copy it yourself."). Used on the setup live step, Today and Share.
 */
export function CopyLink({ url, actions }: CopyLinkProps) {
  const field = useRef<HTMLDivElement>(null);
  const { state, copy } = useCopyText(writeToClipboard);
  const target = () => field.current?.querySelector<HTMLElement>('[data-copy="code"]') ?? null;
  return (
    <div className="cd-copy-link">
      <div className="cd-copy-link__row">
        <div ref={field} className="cd-copy-link__field">
          <CopyField value={url} language="en" />
        </div>
        <Button variant="secondary" size="main" onClick={() => void copy(url, target())}>
          Copy link
        </Button>
        {actions}
      </div>
      {/* Always there, so the line after a press is read out when it appears. */}
      <p role="status" className="cd-copy-link__result cd-type-meta">
        {copyResultLine(state, { what: 'link' })}
      </p>
    </div>
  );
}
