/**
 * The About this prototype pages by name and route, for the owner sidebar and the reader's links. This module
 * holds no document and no parser, so code that only links to the pages never loads either: the documents load
 * with the reader, behind its route's `import()`.
 */
import type { SidebarAbout, SidebarAboutLink } from '../ds/index.ts';

/** The two documents the reader shows. */
export type AboutId = 'proposal' | 'prediction';

/** Each document's route and title. */
export const ABOUT_PAGES: Record<AboutId, { route: string; title: string }> = {
  prediction: { route: '/about/prediction', title: 'Capability prediction' },
  proposal: { route: '/about/proposal', title: 'Product proposal' },
};

/** The Vision article's route and title. It is no document, so the reader's switch between the two leaves it out. */
export const VISION_ARTICLE = { route: '/about/vision', title: 'Vision' } as const;

// The prediction comes first (project owner, 2026-10-30).
const ORDER: AboutId[] = ['prediction', 'proposal'];

/** The two documents as links, in order: the reader's switch between them. */
export const DOCUMENT_LINKS: SidebarAboutLink[] = ORDER.map((id) => ({ id, label: ABOUT_PAGES[id].title, href: ABOUT_PAGES[id].route }));

/** The sidebar's "About this prototype" group: the two documents, then the Vision article. */
export const ABOUT_LINKS: SidebarAbout = {
  title: 'About this prototype',
  links: [...DOCUMENT_LINKS, { id: 'vision', label: VISION_ARTICLE.title, href: VISION_ARTICLE.route }],
};
