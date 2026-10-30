/**
 * The About this prototype pages by name and route, for the owner sidebar and the reader's links. This module
 * holds no document and no parser, so code that only links to the pages never loads either: the documents load
 * with the reader, behind its route's `import()`.
 */
import type { SidebarAbout } from '../ds/index.ts';

export type AboutId = 'proposal' | 'prediction';

/** Each page's route and title, in the order the sidebar lists them. */
export const ABOUT_PAGES: Record<AboutId, { route: string; title: string }> = {
  proposal: { route: '/about/proposal', title: 'Product proposal' },
  prediction: { route: '/about/prediction', title: 'Capability prediction' },
};

const ORDER: AboutId[] = ['proposal', 'prediction'];

/** The sidebar's "About this prototype" group. */
export const ABOUT_LINKS: SidebarAbout = {
  title: 'About this prototype',
  links: ORDER.map((id) => ({ id, label: ABOUT_PAGES[id].title, href: ABOUT_PAGES[id].route })),
};
