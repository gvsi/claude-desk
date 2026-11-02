import { ABOUT_LINKS } from '../about/links.ts';
import type { SidebarAbout } from '../ds/index.ts';

/** The sidebar's documents followed by the external source repository. */
export const SIDEBAR_ABOUT: SidebarAbout = {
  ...ABOUT_LINKS,
  links: [...ABOUT_LINKS.links, { id: 'github', label: 'GitHub', href: 'https://github.com/gvsi/claude-desk', external: true, icon: 'github' }],
};
