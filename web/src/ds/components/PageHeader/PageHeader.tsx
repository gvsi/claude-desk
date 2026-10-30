import type { ReactNode } from 'react';

import './PageHeader.css';

export interface PageHeaderProps {
  /** The page's name, in sentence case: "Rules", "Safety". It is the page's one `h1`. */
  title: ReactNode;
  /** One quiet line under the title that says what the page is for. */
  subtitle?: ReactNode;
  /** The page's controls, at the right of the title's line: usually one `Button`. */
  actions?: ReactNode;
  /**
   * Under 640 px of the window, the actions take a line of their own under the title, at the
   * header's full width, 16 px under it: the Rules page's preset menu (N-Conn-22-Phone-Presets).
   */
  actionsBelowOnPhone?: boolean;
  /** Under 640 px of the window, the subtitle isn't shown, as the phone presets board draws the Rules page. */
  hideSubtitleOnPhone?: boolean;
}

/**
 * The top of an owner page: its title in serif `page-title`, left-aligned, an optional subtitle,
 * and the page's actions at the right. On a narrow line the actions drop under the title; on a
 * phone they stay beside it unless `actionsBelowOnPhone` gives them a line of their own.
 */
export function PageHeader({ title, subtitle, actions, actionsBelowOnPhone = false, hideSubtitleOnPhone = false }: PageHeaderProps) {
  const modifiers = [actionsBelowOnPhone ? ' cd-page-header--actions-below' : '', hideSubtitleOnPhone ? ' cd-page-header--no-phone-subtitle' : ''].join('');
  return (
    <header className={`cd-page-header${modifiers}`}>
      <div className="cd-page-header__text">
        <h1 className="cd-page-header__title cd-type-page-title">{title}</h1>
        {subtitle ? <p className="cd-page-header__subtitle cd-type-body">{subtitle}</p> : null}
      </div>
      {actions ? <div className="cd-page-header__actions">{actions}</div> : null}
    </header>
  );
}
