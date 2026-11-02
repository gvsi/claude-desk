import type { CSSProperties } from 'react';

import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { brandColor, openStatusLine } from './guards.ts';
import type { PublicBrand, PublicOpenStatus } from './PublicShell.tsx';

import './PublicShell.css';

/** The shell's own line under a closed status, in the visitor's language. */
const STILL_HELPS = {
  en: 'Claude can still help.',
  es: 'Claude puede ayudarte igual.',
} as const satisfies Record<CopyLanguage, string>;

export interface PublicBrandHeaderProps {
  brand: PublicBrand;
  /** The visitor's language: the header's own line, and `lang` on it. */
  language: CopyLanguage;
  /** `PublicDesk.open_status` as served; without it, or when it isn't whole, no status line. */
  openStatus?: PublicOpenStatus;
  /** `false` inside an owner screen: a plain block, not the page's banner. */
  landmark?: boolean;
  /** `false` on a page with its own title, such as the agents page: the name is a line, not the `h1`. */
  nameAsHeading?: boolean;
}

/**
 * The public page's brand header in the business's own colors: the monogram, the name and the Desk,
 * the kernel's open status at the right when the Desk has hours, and the accent as a 2 px rule
 * under it. `PublicShell` draws it over the chat; a public page without a chat, such as
 * `/d/:slug/agents`, draws it on its own. It is its own inline-size container, so its gutters and
 * the status line follow its own width.
 */
export function PublicBrandHeader({ brand, language, openStatus, landmark = true, nameAsHeading = true }: PublicBrandHeaderProps) {
  const style = {
    '--brand-field': brandColor(brand.field, 'var(--bg-panel)'),
    '--brand-ink': brandColor(brand.ink, 'var(--text-primary)'),
    '--brand-ink-secondary': brandColor(brand.inkSecondary, 'var(--text-secondary)'),
    '--brand-status-handled': brandColor(brand.statusHandled, 'var(--status-handled)'),
    '--brand-accent': brandColor(brand.accent, 'var(--line-hairline)'),
  } as CSSProperties;
  const Header = landmark ? 'header' : 'div';
  const BrandName = nameAsHeading ? 'h1' : 'p';
  const status = openStatusLine(openStatus);

  return (
    <div className="cd-public-brand" lang={language} style={style}>
      <Header className={`cd-public-shell__brand${status ? ' cd-public-shell__brand--open-status' : ''}`}>
        <span className="cd-public-shell__monogram cd-type-page-title" aria-hidden="true">
          {brand.monogram}
        </span>
        <div className="cd-public-shell__brand-text" data-copy="user">
          <BrandName className="cd-public-shell__brand-name cd-type-brand-name">{brand.name}</BrandName>
          <p className="cd-public-shell__tagline cd-type-meta">{brand.tagline}</p>
        </div>
        <PublicBusinessStatus openStatus={openStatus} language={language} />
      </Header>
    </div>
  );
}

/** The kernel's status, shared by the brand header and the wide About column. */
export function PublicBusinessStatus({ openStatus, language }: Pick<PublicBrandHeaderProps, 'openStatus' | 'language'>) {
  const status = openStatusLine(openStatus);
  if (!status) return null;
  return (
    <div className="cd-public-shell__open-status">
      <StatusDot tone={status.open ? 'handled' : 'info'} />
      <div className="cd-public-shell__open-status-lines">
        {/* The kernel's words, as written. */}
        <p className="cd-public-shell__open-status-text cd-type-meta" data-copy="user">
          {status.text}
        </p>
        {status.open ? null : <p className="cd-public-shell__still-helps cd-type-caption">{STILL_HELPS[language] ?? STILL_HELPS.en}</p>}
      </div>
    </div>
  );
}
