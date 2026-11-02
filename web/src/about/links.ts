/**
 * The About this prototype pages by name, route and one line, for the owner sidebar and the pages' own links. This
 * module holds no document and no parser, so code that only links to the pages never loads either: the documents
 * load with the reader, behind its route's `import()`.
 */
import type { SidebarAbout, SidebarAboutLink } from '../ds/index.ts';

/** The two documents the reader shows. */
export type AboutId = 'proposal' | 'prediction';

/** Every page of the About set: the two documents, then the Vision article. */
export type AboutPageId = AboutId | 'vision';

export interface AboutPage {
  route: string;
  title: string;
  /** The one line under the page's title, and under its name on a "Read next" card. */
  summary: string;
}

/** Each document's route, title and summary. */
export const ABOUT_PAGES: Record<AboutId, AboutPage> = {
  prediction: {
    route: '/about/prediction',
    title: 'Capability prediction',
    summary: 'What a generally available Claude model will do for a small business by October 2027, and what will still hold it back.',
  },
  proposal: {
    route: '/about/proposal',
    title: 'Product proposal',
    summary: 'What Claude Desk is, who it’s for, what the first release enforces in code, and how we’ll know it works.',
  },
};

/** The Vision article's route, title and the line its "Read next" card shows. It is no document: its words are its own. */
export const VISION_ARTICLE: AboutPage = {
  route: '/about/vision',
  title: 'Vision',
  summary: 'A front desk that never closes: where a Desk could go next, and the rules that wouldn’t change.',
};

/** Every page of the set, by its id. */
const SET: Record<AboutPageId, AboutPage> = { ...ABOUT_PAGES, vision: VISION_ARTICLE };

// The prediction comes first (project owner, 2026-10-30), then the proposal and the Vision article (2026-10-31).
const ORDER: AboutPageId[] = ['prediction', 'proposal', 'vision'];

/** The set as links, in order: the sidebar's group, and the switch at the top of each of its pages. */
export const ABOUT_SET_LINKS: SidebarAboutLink[] = ORDER.map((id) => ({ id, label: SET[id].title, href: SET[id].route }));

/** The sidebar's "About this prototype" group: the two documents, then the Vision article. */
export const ABOUT_LINKS: SidebarAbout = {
  title: 'About this prototype',
  links: ABOUT_SET_LINKS,
};

/** What "Read next" offers at the end of a page: the next page in the set, and after the last, the first again. */
export function readNext(id: AboutPageId): AboutPage {
  return SET[ORDER[(ORDER.indexOf(id) + 1) % ORDER.length] ?? 'prediction'];
}
