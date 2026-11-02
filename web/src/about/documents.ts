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

export interface AboutDocument {
  route: string;
  title: string;
  /** The one line under the title (`links.ts`). */
  summary: string;
  /** A sentence of the document, shown after its first section. */
  pullQuote: string;
  /** The figure under the summary; its marker in the article renders nothing. */
  hero: FigureName;
  /** The other document: "Also read" beside this one, and the one a relative link in it may name. */
  next: AboutId;
  blocks: Block[];
}

interface Source {
  file: string;
  next: AboutId;
  /** The page's named changes to the Markdown, applied before parsing. */
  forThePage: (markdown: string) => string;
  words: Pick<AboutDocument, 'pullQuote' | 'hero'>;
}

const SOURCES: Record<AboutId, Source> = {
  proposal: {
    file: 'product-proposal.md',
    next: 'prediction',
    forThePage: proposalForThePage,
    words: {
      pullQuote: 'Prompt injection and social engineering can’t make it act past the owner’s rules.',
      hero: 'architecture',
    },
  },
  prediction: {
    file: 'capability-prediction.md',
    next: 'proposal',
    forThePage: (markdown) => markdown,
    words: {
      pullQuote: 'It will still be open to prompt injection and social engineering, so the business’s limits have to be enforced in code, outside the model.',
      hero: 'tau3',
    },
  },
};

/**
 * One document's page from its Markdown, with curly quote marks where the Markdown has straight ones. A
 * `MarkdownError` names the file as well as the line.
 */
export function readDocument(id: AboutId, markdown: string): AboutDocument {
  const { file, next, forThePage, words } = SOURCES[id];
  // The one relative link a document may hold is the other document's file name, which becomes its page.
  const resolve = (target: string) => (target === SOURCES[next].file ? ABOUT_PAGES[next].route : undefined);
  try {
    return { ...ABOUT_PAGES[id], ...words, next, blocks: curlQuotes(parseDocument(forThePage(markdown), resolve)) };
  } catch (error) {
    if (error instanceof MarkdownError) throw new MarkdownError(error.line, error.reason, `docs/${file}`);
    throw error;
  }
}

export const ABOUT_DOCUMENTS: Record<AboutId, AboutDocument> = {
  proposal: readDocument('proposal', proposalMarkdown),
  prediction: readDocument('prediction', predictionMarkdown),
};
