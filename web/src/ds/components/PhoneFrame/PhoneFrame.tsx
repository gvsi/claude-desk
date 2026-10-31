import { useId, type ReactNode } from 'react';

import { Icon, type IconName } from '../../icons/index.tsx';

import './PhoneFrame.css';

/** The owner app's five tabs on a phone, in their fixed order. */
export type PhoneTab = 'today' | 'chats' | 'rules' | 'safety' | 'more';

export interface PhoneFrameProps {
  /** What the phone shows, under it and as the figure's name: "Today, for the owner". */
  caption: string;
  /** The screen: its page, then what sits at its foot (a `PhoneTabBar`, or a visitor's composer). */
  children: ReactNode;
}

/**
 * A phone drawn on a page: a 390 by 780 px screen with the rounded corners of a phone, and a caption
 * under it saying what it shows. The screen is a column: the content lays out its own page and puts
 * a `PhoneTabBar` or a composer last, at the foot.
 */
export function PhoneFrame({ caption, children }: PhoneFrameProps) {
  const captionId = useId();
  return (
    // The caption names the figure for every screen reader, not only those that read figcaption.
    <figure className="cd-phone-frame" aria-labelledby={captionId}>
      <div className="cd-phone-frame__screen">{children}</div>
      <figcaption id={captionId} className="cd-phone-frame__caption cd-type-meta">
        {caption}
      </figcaption>
    </figure>
  );
}

const TABS = [
  { key: 'today', icon: 'today', label: 'Today' },
  { key: 'chats', icon: 'conversations', label: 'Chats' },
  { key: 'rules', icon: 'rules', label: 'Rules' },
  { key: 'safety', icon: 'safety', label: 'Safety' },
  { key: 'more', icon: 'settings', label: 'More' },
] as const satisfies readonly { key: PhoneTab; icon: IconName; label: string }[];

export interface PhoneTabBarProps {
  /** The tab the owner is on; it is marked `aria-current="page"`. */
  current: PhoneTab;
  /** Where each tab goes. More holds Connectors, Customers, Share and Settings. */
  hrefs: Record<PhoneTab, string>;
  /**
   * The bar's accessible name: "The owner app's tabs" by default. It is a picture of an app's tabs on
   * a page with its own navigation, so it never claims to be the page's "Main".
   */
  label?: string;
}

/**
 * The owner app's tab bar on a phone, at the foot of the screen: Today, Chats, Rules, Safety and
 * More, each a 20 px icon over its name, the current one in primary ink.
 */
export function PhoneTabBar({ current, hrefs, label = "The owner app's tabs" }: PhoneTabBarProps) {
  return (
    <nav className="cd-phone-tab-bar" aria-label={label}>
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={hrefs[tab.key]}
          className="cd-phone-tab-bar__tab"
          {...(tab.key === current ? { 'aria-current': 'page' as const } : {})}
        >
          <Icon name={tab.icon} />
          <span className="cd-type-caption">{tab.label}</span>
        </a>
      ))}
    </nav>
  );
}
