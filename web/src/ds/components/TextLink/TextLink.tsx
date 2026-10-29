import type { ReactNode } from 'react';

import './TextLink.css';

export interface TextLinkProps {
  href: string;
  /** Where the link goes, in words: "See rule", "See the briefing". */
  children: ReactNode;
  /** Leaves the app: opens a new tab with `rel="noopener noreferrer"`. */
  external?: boolean;
}

export function TextLink({ href, children, external = false }: TextLinkProps) {
  return (
    <a
      className="cd-text-link"
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}
