import type { ReactNode } from 'react';

import './TextLink.css';

export interface TextLinkProps {
  href: string;
  /** Where the link goes, in words: "See rule", "See the briefing". */
  children: ReactNode;
  /** Leaves the app: opens a new tab with `rel="noopener noreferrer"`. */
  external?: boolean;
  /** Inside a sentence: only the words take taps, with no enlarged touch hit area. */
  runningText?: boolean;
}

export function TextLink({ href, children, external = false, runningText = false }: TextLinkProps) {
  return (
    <a
      className={`cd-text-link${runningText ? ' cd-text-link--running-text' : ''}`}
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}
