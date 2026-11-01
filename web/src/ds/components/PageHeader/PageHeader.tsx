import type { ReactNode, Ref } from 'react';

import './PageHeader.css';

export interface PageHeaderProps {
  /** The page's name, in sentence case: "Rules", "Safety". It is the page's one `h1`. */
  title: ReactNode;
  /** One quiet line under the title that says what the page is for. */
  subtitle?: ReactNode;
  /** A quieter line under the subtitle, in meta type: what a term met on the page means. */
  note?: ReactNode;
  /** The page's controls, at the right of the title's line: usually one `Button`. */
  actions?: ReactNode;
  /**
   * Under 640 px of the window, the actions take a line of their own under the title, at the
   * header's full width, 16 px under it: the Rules page's See all rules and preset menu
   * (N-Conn-22-Phone-Presets).
   */
  actionsBelowOnPhone?: boolean;
  /** Under 640 px of the window, the subtitle isn't shown, as the phone presets board draws the Rules page. */
  hideSubtitleOnPhone?: boolean;
  /** The title, for a script to move focus to: it then takes focus (`tabIndex={-1}`), never a Tab stop. */
  titleRef?: Ref<HTMLHeadingElement>;
}

/**
 * The top of an owner page: its title in serif `page-title`, left-aligned, an optional subtitle,
 * and the page's actions at the right. On a narrow line the actions drop under the title; on a
 * phone they stay beside it unless `actionsBelowOnPhone` gives them a line of their own.
 */
export function PageHeader({ title, subtitle, note, actions, actionsBelowOnPhone = false, hideSubtitleOnPhone = false, titleRef }: PageHeaderProps) {
  const modifiers = [actionsBelowOnPhone ? ' cd-page-header--actions-below' : '', hideSubtitleOnPhone ? ' cd-page-header--no-phone-subtitle' : ''].join('');
  return (
    <header className={`cd-page-header${modifiers}`}>
      <div className="cd-page-header__text">
        <h1 ref={titleRef} className="cd-page-header__title cd-type-page-title" tabIndex={titleRef === undefined ? undefined : -1}>
          {title}
        </h1>
        {subtitle ? <p className="cd-page-header__subtitle cd-type-body">{subtitle}</p> : null}
        {note ? <p className="cd-page-header__note cd-type-meta">{note}</p> : null}
      </div>
      {actions ? <div className="cd-page-header__actions">{actions}</div> : null}
    </header>
  );
}
