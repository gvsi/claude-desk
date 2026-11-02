/**
 * The two documents the About this prototype pages show, embedded from `docs/` at build time and parsed when
 * this module first runs. Only the reader imports it, through its route's `import()`, so a document that can't
 * be parsed stays on its own page. This is the one module that imports the parser and the Markdown files.
 */
import predictionMarkdown from '../../../docs/capability-prediction.md?raw';
import proposalMarkdown from '../../../docs/product-proposal.md?raw';

import { ABOUT_PAGES, type AboutId } from './links.ts';
import { curlQuotes, MarkdownError, parseDocument, type Block, type FigureName } from './markdown.ts';

export { documentText, inlineText, MarkdownError, readingMinutes } from './markdown.ts';
export type { Block, FigureName, Inline } from './markdown.ts';

// The proposal's sentence that gives the hosted prototype's address, which reads oddly on the hosted page
// itself. `$1` keeps the whole repository link: the placeholder until it is given, the Markdown link after.
// It ends at the period that ends the sentence, one followed by whitespace or the end of the text, so a dot
// inside the link (github.com) doesn't end it. Exported for the tests. A global pattern keeps a `lastIndex`
// that an importer's `test` or `exec` moves, so `proposalForThePage` works on a fresh copy and never reads or
// changes the exported one's.
export const PROTOTYPE_SENTENCE = /The prototype, v1['’]s enforced core, is at .+?, with the code at (.+?)\.(?=\s|$)/g;
const ON_THE_PAGE = 'You’re in it. The code is at $1.';

/** The proposal's Markdown as its page shows it: the prototype sentence replaced, which must match exactly once. */
export function proposalForThePage(markdown: string): string {
  const sentence = new RegExp(PROTOTYPE_SENTENCE);
  const found = [...markdown.matchAll(sentence)];
  if (found.length !== 1) {
    const second = found[1];
    const line = second ? markdown.slice(0, second.index).split('\n').length : null;
    throw new MarkdownError(line, `the sentence about where the prototype is matched ${found.length} times, not once`);
  }
  return markdown.replace(sentence, ON_THE_PAGE);
}

/** The blocks a card holds, by their places in the document, the last one included. */
export interface BlockSpan {
  first: number;
  last: number;
}

export interface AboutDocument {
  route: string;
  title: string;
  /** The one line under the title (`links.ts`). */
  summary: string;
  /**
   * How the page opens. `hero`: the app icon, then "About this prototype", the title and the summary centred
   * above the lead figure, `hero`. `column`: "About this prototype", the title and the summary left-aligned at the
   * top of the article's column, with no icon and no lead figure.
   */
  layout: 'hero' | 'column';
  /** The figure under the summary in the `hero` layout; its marker in the article renders nothing. */
  hero?: FigureName;
  /** A sentence of the document, shown after its first section. */
  pullQuote?: string;
  /** The opening of the first section that the page sets in a card with the prediction at a glance (`claimOf`). */
  claim?: BlockSpan;
  /** The other document: "Also read" beside this one, and the one a relative link in it may name. */
  next: AboutId;
  blocks: Block[];
}

interface Source {
  file: string;
  next: AboutId;
  /** The page's named changes to the Markdown, applied before parsing. */
  forThePage: (markdown: string) => string;
  words: Pick<AboutDocument, 'layout' | 'pullQuote' | 'hero'>;
  /** Whether the first section's opening is set as a claim card (`claimOf`). */
  claimCard?: true;
}

const SOURCES: Record<AboutId, Source> = {
  proposal: {
    file: 'product-proposal.md',
    next: 'prediction',
    forThePage: proposalForThePage,
    words: {
      layout: 'hero',
      pullQuote: 'Prompt injection and social engineering can’t make Claude act past the owner’s rules.',
      hero: 'architecture',
    },
  },
  prediction: {
    file: 'capability-prediction.md',
    next: 'proposal',
    forThePage: (markdown) => markdown,
    words: { layout: 'column' },
    claimCard: true,
  },
};

/**
 * The blocks of the claim the page sets in a card at the top of the first section, so the card shows the document's
 * own words: the paragraph that opens the section, one bold run (the lead), the list under it and the paragraph after
 * it (the caveat). A document whose first section doesn't open that way fails here.
 */
function claimOf(blocks: Block[]): BlockSpan {
  const section = blocks.findIndex((block) => block.kind === 'heading' && block.depth === 2);
  const [lead, list, caveat] = section < 0 ? [] : blocks.slice(section + 1, section + 4);
  const boldLead = lead?.kind === 'paragraph' && lead.children.length === 1 && lead.children[0]?.kind === 'strong';
  if (!boldLead || list?.kind !== 'list' || caveat?.kind !== 'paragraph') {
    throw new MarkdownError(null, 'the claim card needs the first section to open with a bold lead, a list and a paragraph');
  }
  return { first: section + 1, last: section + 3 };
}

/**
 * One document's page from its Markdown, with curly quote marks where the Markdown has straight ones. A
 * `MarkdownError` names the file as well as the line.
 */
export function readDocument(id: AboutId, markdown: string): AboutDocument {
  const { file, next, forThePage, words, claimCard } = SOURCES[id];
  // The one relative link a document may hold is the other document's file name, which becomes its page.
  const resolve = (target: string) => (target === SOURCES[next].file ? ABOUT_PAGES[next].route : undefined);
  try {
    const blocks = curlQuotes(parseDocument(forThePage(markdown), resolve));
    return { ...ABOUT_PAGES[id], ...words, ...(claimCard ? { claim: claimOf(blocks) } : {}), next, blocks };
  } catch (error) {
    if (error instanceof MarkdownError) throw new MarkdownError(error.line, error.reason, `docs/${file}`);
    throw error;
  }
}

export const ABOUT_DOCUMENTS: Record<AboutId, AboutDocument> = {
  proposal: readDocument('proposal', proposalMarkdown),
  prediction: readDocument('prediction', predictionMarkdown),
};
