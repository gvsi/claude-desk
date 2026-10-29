import type { ReactNode } from 'react';

import './PageHeader.css';

export interface PageHeaderProps {
  /** The page's name, in sentence case: "Rules", "Safety". It is the page's one `h1`. */
  title: ReactNode;
  /** One quiet line under the title that says what the page is for. */
  subtitle?: ReactNode;
  /** The page's controls, at the right of the title's line: usually one `Button`. */
  actions?: ReactNode;
}

/**
 * The top of an owner page: its title in serif `page-title`, left-aligned, an optional subtitle,
 * and the page's actions at the right. On a narrow line the actions drop under the title.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="cd-page-header">
      <div className="cd-page-header__text">
        <h1 className="cd-page-header__title cd-type-page-title">{title}</h1>
        {subtitle ? <p className="cd-page-header__subtitle cd-type-body">{subtitle}</p> : null}
      </div>
      {actions ? <div className="cd-page-header__actions">{actions}</div> : null}
    </header>
  );
}
