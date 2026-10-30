/**
 * The two documents the About this prototype pages show, parsed by the reader itself. These tests run on
 * every push, so a change to docs/product-proposal.md or docs/capability-prediction.md that the page couldn't
 * show as written fails here before it can reach a deploy. Expected text is built from the raw Markdown,
 * read from disk line by line, never with the parser under test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ABOUT_DOCUMENTS,
  documentText,
  MarkdownError,
  proposalForThePage,
  readDocument,
  type Block,
  type Inline,
} from './documents.ts';
import { ABOUT_LINKS } from './links.ts';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs');

/** A document's Markdown as committed. */
function raw(file: string): string {
  return readFileSync(path.join(DOCS, file), 'utf8');
}

/** Every link in the blocks, in order. */
function links(blocks: Block[]): Extract<Inline, { kind: 'link' }>[] {
  const walk = (inlines: Inline[]): Extract<Inline, { kind: 'link' }>[] =>
    inlines.flatMap((inline) => [
      ...(inline.kind === 'link' ? [inline] : []),
      ...('children' in inline ? walk(inline.children) : []),
    ]);
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case 'paragraph':
        return walk(block.children);
      case 'list':
        return block.items.flatMap(walk);
      case 'table':
        return [...block.head, ...block.rows.flat()].flatMap(walk);
      default:
        return [];
    }
  });
}

// The page's one change to the proposal's words, as the About readers plan writes it, so a change to the
// pattern or the words in documents.ts fails here.
const PROTOTYPE_SENTENCE = /The prototype, v1['’]s enforced core, is at .+?, with the code at (.+?)\./g;
const ON_THE_PAGE = 'You’re in it. The code is at $1.';

/** Quote marks as the Markdown types them, so the page's curly ones compare equal to the document's words. */
function straight(value: string): string {
  return value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** A line's words with the Markdown taken off: link text without its target, placeholders' words, no ** or `. */
function words(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[((?:measured|owner): [^\]]*)\]/g, '$1')
    .replaceAll('**', '')
    .replaceAll('`', '');
}

/**
 * The article's text, stripped from the Markdown line by line: after the title and the byline, each `##`
 * heading, paragraph and list item, and each table's cells, header first, without the divider row. Figure
 * markers and the image line add nothing.
 */
function articleText(markdown: string): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) out.push(words(paragraph.join(' ')));
    paragraph = [];
  };
  const lines = markdown.split('\n');
  const withText = lines.flatMap((line, index) => (line.trim() === '' ? [] : [index]));
  // The first two lines with text are the title and the byline.
  for (const line of lines.slice((withText[1] ?? lines.length) + 1)) {
    if (line.trim() === '' || line.startsWith('<!-- figure: ') || line.startsWith('![')) {
      endParagraph();
    } else if (line.startsWith('## ')) {
      endParagraph();
      out.push(line.slice(3));
    } else if (line.startsWith('- ')) {
      endParagraph();
      out.push(words(line.slice(2)));
    } else if (line.startsWith('|')) {
      endParagraph();
      if (!/^[|\s:-]+$/.test(line)) out.push(...line.slice(1, -1).split('|').map((cell) => words(cell.trim())));
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return out;
}

const DOCUMENTS = [
  { id: 'proposal', file: 'product-proposal.md', figures: ['architecture'], internal: ['/about/prediction'] },
  { id: 'prediction', file: 'capability-prediction.md', figures: ['tau3', 'readiness'], internal: [] },
] as const;

describe('the About documents', () => {
  it('both_documents_parse_fully', () => {
    for (const { id, file, figures, internal } of DOCUMENTS) {
      const { blocks } = ABOUT_DOCUMENTS[id];
      const lines = raw(file).split('\n');
      const [title, byline] = lines.filter((line) => line.trim() !== '');

      expect(blocks[0], file).toMatchObject({ kind: 'heading', depth: 1, text: title?.replace(/^# /, '') });
      expect(blocks[1], file).toEqual({ kind: 'byline', text: byline });
      // Every section, in the order the Markdown has them.
      const sections = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
      expect(sections.length, file).toBeGreaterThan(3);
      expect(
        blocks.flatMap((block) => (block.kind === 'heading' && block.depth === 2 ? [straight(block.text)] : [])),
        file,
      ).toEqual(sections.map(straight));
      expect(blocks.flatMap((block) => (block.kind === 'figure' ? [block.name] : [])), file).toEqual(figures);
      // The proposal's one link to the prediction goes to its page; every other link is an https:// address.
      const found = links(blocks);
      expect(found.filter((link) => link.internal).map((link) => link.href), file).toEqual(internal);
      expect(found.filter((link) => !link.internal).every((link) => link.href.startsWith('https://')), file).toBe(true);
      // None is lost: every `](` in the Markdown is a link, except the architecture figure's image line.
      const count = (pattern: RegExp) => raw(file).match(pattern)?.length ?? 0;
      expect(found.length, file).toBe(count(/\]\(/g) - count(/!\[/g));
    }
  });

  it('article_text_is_the_document', () => {
    for (const { id, file } of DOCUMENTS) {
      // The one named change to the article's words: the proposal's sentence about where the prototype is.
      const markdown = id === 'proposal' ? raw(file).replace(PROTOTYPE_SENTENCE, ON_THE_PAGE) : raw(file);
      const expected = articleText(markdown);
      expect(expected.length, file).toBeGreaterThan(30);

      expect(documentText(ABOUT_DOCUMENTS[id].blocks).map(straight), file).toEqual(expected.map(straight));
    }

    // A parse that dropped, repeated or reordered a block would fail the comparison above.
    const { blocks } = ABOUT_DOCUMENTS.proposal;
    const expected = articleText(raw('product-proposal.md').replace(PROTOTYPE_SENTENCE, ON_THE_PAGE));
    const paragraphs = blocks.flatMap((block, index) => (block.kind === 'paragraph' ? [index] : []));
    const [a = 0, b = 0] = [paragraphs[2], paragraphs[5]];
    const dropped = blocks.filter((_, index) => index !== a);
    const repeated = [...blocks.slice(0, a + 1), ...blocks.slice(a)];
    const swapped = blocks.map((block, index) => (index === a ? blocks[b] : index === b ? blocks[a] : block)) as Block[];
    for (const changed of [dropped, repeated, swapped]) {
      expect(documentText(changed).map(straight)).not.toEqual(expected.map(straight));
    }
  });

  it('the_registry_and_the_links_name_each_page', () => {
    expect(ABOUT_LINKS).toEqual({
      title: 'About this prototype',
      links: [
        { id: 'prediction', label: 'Capability prediction', href: '/about/prediction' },
        { id: 'proposal', label: 'Product proposal', href: '/about/proposal' },
      ],
    });
    const { blocks: _proposal, ...proposal } = ABOUT_DOCUMENTS.proposal;
    expect(proposal).toEqual({
      route: '/about/proposal',
      title: 'Product proposal',
      summary: 'What Claude Desk is, who it’s for, what v1 enforces in code, and how we’ll know it works.',
      pullQuote: 'Talking Claude around can’t make it act past the owner’s rules.',
      hero: 'architecture',
      next: 'prediction',
    });
    const { blocks: _prediction, ...prediction } = ABOUT_DOCUMENTS.prediction;
    expect(prediction).toEqual({
      route: '/about/prediction',
      title: 'Capability prediction',
      summary:
        'What a generally available Claude model will do for a small business by October 2027, and what will still hold it back.',
      pullQuote: 'It will still be talked around often enough that its limits must sit in code.',
      hero: 'tau3',
      next: 'proposal',
    });
    // Each hero figure is one its document places.
    for (const { id } of DOCUMENTS) {
      expect(ABOUT_DOCUMENTS[id].blocks).toContainEqual({ kind: 'figure', name: ABOUT_DOCUMENTS[id].hero });
    }
  });

  it('pull_quotes_are_sentences_of_their_documents', () => {
    // The page writes curly quote marks and the documents straight ones; the words must be the same.
    const sentences = (paragraph: string) => paragraph.split(/(?<=[.!?])\s+/);
    for (const { id, file } of DOCUMENTS) {
      const { pullQuote, blocks } = ABOUT_DOCUMENTS[id];
      const inTheDocument = documentText(blocks).flatMap(sentences).map(straight);
      expect(inTheDocument, file).toContain(straight(pullQuote));
      // Read from disk too, so the quote is the document's and not only the parse's.
      expect(raw(file), file).toContain(straight(pullQuote));
    }
    expect(ABOUT_DOCUMENTS.proposal.pullQuote).toBe('Talking Claude around can’t make it act past the owner’s rules.');
    expect(ABOUT_DOCUMENTS.prediction.pullQuote).toBe(
      'It will still be talked around often enough that its limits must sit in code.',
    );
  });

  it('the_pages_show_curly_quote_marks', () => {
    /** Every piece of words the page shows from the blocks, code left out. */
    const shown = (blocks: Block[]): string[] => {
      const walk = (inlines: Inline[]): string[] =>
        inlines.flatMap((inline) =>
          'children' in inline ? walk(inline.children) : inline.kind === 'code' ? [] : [inline.text],
        );
      return blocks.flatMap((block) => {
        switch (block.kind) {
          case 'heading':
          case 'byline':
            return [block.text];
          case 'paragraph':
            return walk(block.children);
          case 'list':
            return block.items.flatMap(walk);
          case 'table':
            return [...block.head, ...block.rows.flat()].flatMap(walk);
          case 'figure':
            return [];
        }
      });
    };
    for (const { id, file } of DOCUMENTS) {
      // The Markdown keeps its straight ones; the page shows none.
      expect(raw(file), file).toMatch(/'[^]*"|"[^]*'/);
      expect(shown(ABOUT_DOCUMENTS[id].blocks).filter((piece) => /['"]/.test(piece)), file).toEqual([]);
      // Double marks pair up inside each piece, the opening one first.
      for (const piece of documentText(ABOUT_DOCUMENTS[id].blocks)) {
        expect(piece.replace(/[^“”]/g, ''), file).toMatch(/^(?:“”)*$/);
      }
    }
    // The only opening single marks are the prediction's nested quotation's; every other ' is an apostrophe.
    expect(documentText(ABOUT_DOCUMENTS.prediction.blocks).join('\n').match(/‘\S+/g)).toEqual(['‘capable’', '‘completely']);
    expect(documentText(ABOUT_DOCUMENTS.proposal.blocks).join('\n')).not.toContain('‘');
    const prediction = documentText(ABOUT_DOCUMENTS.prediction.blocks);
    expect(prediction).toContain('Why it’s coming');
    expect(prediction.join('\n')).toContain('“the gap between ‘capable’ and ‘completely robust’ remains wide”');
    expect(prediction.join('\n')).toContain('such as a visitor saying “I’m the owner”.');
    // After a link, the quote mark closes the link's last word.
    expect(documentText(ABOUT_DOCUMENTS.proposal.blocks).join('\n')).toContain('’s $20 monthly');
  });

  const HOSTED = '[owner: hosted URL; the passcode comes with the link]';
  const REPO = '[owner: repo link]';

  it('the_replacement_matches_once_before_and_after_the_fill', () => {
    const proposal = raw('product-proposal.md');
    const filled = proposal
      .replace(HOSTED, '[desk.example.com](https://desk.example.com)')
      .replace(REPO, '[github.com/example/claude-desk](https://github.com/example/claude-desk)');
    expect(filled).not.toContain('[owner:');
    expect(proposal.match(PROTOTYPE_SENTENCE)).toHaveLength(1);
    expect(filled.match(PROTOTYPE_SENTENCE)).toHaveLength(1);

    // Before the fill: the hosted address goes, and the repository placeholder stays visible.
    const page = proposalForThePage(proposal);
    expect(page).toContain(`You’re in it. The code is at ${REPO}. Each visitor acts as Maria`);
    expect(page).not.toContain(HOSTED);
    expect(page.replace(`You’re in it. The code is at ${REPO}.`, '')).toBe(proposal.replace(PROTOTYPE_SENTENCE, ''));
    const paragraph = ABOUT_DOCUMENTS.proposal.blocks.find(
      (block) => block.kind === 'paragraph' && block.children[0]?.kind === 'text' && block.children[0].text.startsWith('You’re in it.'),
    );
    expect(paragraph).toMatchObject({
      children: [
        { kind: 'text', text: 'You’re in it. The code is at ' },
        { kind: 'placeholder', text: 'owner: repo link' },
        { kind: 'text', text: expect.stringMatching(/^\. Each visitor acts as Maria/) },
      ],
    });

    // After the fill: the repository link survives as a link.
    const { blocks } = readDocument('proposal', filled);
    expect(blocks).toContainEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: 'You’re in it. The code is at ' },
        {
          kind: 'link',
          href: 'https://github.com/example/claude-desk',
          internal: false,
          children: [{ kind: 'text', text: 'github.com/example/claude-desk' }],
        },
        { kind: 'text', text: expect.stringMatching(/^\. Each visitor acts as Maria/) },
      ],
    });
    expect(links(blocks).map((link) => link.href)).not.toContain('https://desk.example.com');

    // Anything but exactly one match fails loudly, naming the second match's line.
    expect(() => proposalForThePage(raw('capability-prediction.md'))).toThrow(MarkdownError);
    expect(() => proposalForThePage(raw('capability-prediction.md'))).toThrow(
      /^the sentence about where the prototype is matched 0 times, not once$/,
    );
    const first = proposal.split('\n').findIndex((line) => line.startsWith('The prototype, v1')) + 1;
    const twice = proposal.replace(/^(The prototype, v1.*)$/m, '$1\n\n$1');
    expect(() => proposalForThePage(twice)).toThrow(
      `line ${first + 2}: the sentence about where the prototype is matched 2 times, not once`,
    );
    // The documents write straight apostrophes; a curly one still matches.
    expect(proposalForThePage(proposal.replace("v1's enforced", 'v1’s enforced'))).toBe(page);
  });

  it('a_bad_document_names_its_file_and_line', () => {
    const prediction = raw('capability-prediction.md');
    const line = prediction.split('\n').indexOf('## Characteristics') + 1;
    expect(() => readDocument('prediction', prediction.replace('## Characteristics', '### Characteristics'))).toThrow(
      `docs/capability-prediction.md line ${line}: a heading below ##`,
    );
    expect(() => readDocument('proposal', raw('product-proposal.md').replace('The prototype, v1', 'This prototype'))).toThrow(
      'docs/product-proposal.md: the sentence about where the prototype is matched 0 times, not once',
    );
    // Each document links only to the other: the prediction can't link to itself.
    expect(() => readDocument('prediction', `${prediction}\n\nSee [this](capability-prediction.md).\n`)).toThrow(
      /^docs\/capability-prediction\.md line \d+: a link to capability-prediction\.md, neither/,
    );
    expect(readDocument('prediction', `${prediction}\n\nSee [the proposal](product-proposal.md).\n`).blocks.at(-1)).toMatchObject({
      children: [{ kind: 'text', text: 'See ' }, { kind: 'link', href: '/about/proposal', internal: true }, { kind: 'text', text: '.' }],
    });
  });
});
