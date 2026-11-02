import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ConceptFooter, PageHeader, SubNav, type SubNavItem } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { BillingPage } from './BillingPage.tsx';
import { GeneralPage } from './GeneralPage.tsx';
import { NotificationsPage } from './NotificationsPage.tsx';

import './Settings.css';

const TITLE = 'Settings';

/** One of Settings' sections: its SubNav row and its route. */
export interface SettingsSection {
  key: string;
  /** Its row in SubNav: "General". */
  label: string;
  /** Its path under `settings/`: "general". */
  path: string;
  element: ReactNode;
}

/**
 * Settings' sections in SubNav's order, the one list SubNav and the `settings/*` routes both read,
 * so a section is added in one place. Connectors have their own tab, so there is no Integrations
 * entry. Channels joins after Notifications when its page does.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { key: 'general', label: 'General', path: 'general', element: <GeneralPage /> },
  { key: 'notifications', label: 'Notifications', path: 'notifications', element: <NotificationsPage /> },
  // Channels goes here.
  { key: 'billing', label: 'Billing', path: 'billing', element: <BillingPage /> },
];

/** The section `settings` opens on. */
export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0]?.path ?? '';

/**
 * `settings/*`: "Settings" with its sections in SubNav at the left and the section's page beside it,
 * in the content column, the concept footer at the window's foot, as the Settings boards draw it.
 * On a phone, SubNav is one line across the page over a hairline, and the page under it.
 */
export function SettingsLayout() {
  const { desk } = useOwnerDesk();
  const { pathname } = useLocation();
  // Its sections have no heading of their own, so each one's tab is Settings'.
  useDocumentTitle(inApp(TITLE));
  const base = `/app/${encodeURIComponent(desk.desk_id)}/settings`;
  const items: SubNavItem[] = SETTINGS_SECTIONS.map(({ key, label, path }) => ({ key, label, href: `${base}/${path}` }));
  // The segment after `settings`: the section the owner is on.
  const segment = pathname.split('/')[4] ?? '';
  const current = SETTINGS_SECTIONS.find((section) => section.path === segment)?.key ?? '';

  return (
    <div className="cd-settings">
      <div className="cd-settings__page">
        <PageHeader title={TITLE} />
        <div className="cd-settings__columns">
          <div className="cd-settings__nav">
            <SubNav label={TITLE} items={items} current={current} linkComponent={RouterLink} />
          </div>
          <div className="cd-settings__content">
            <Outlet />
          </div>
        </div>
        <footer className="cd-settings__footer">
          <ConceptFooter />
        </footer>
      </div>
    </div>
  );
}
