/**
 * The Markdown reader for the About this prototype pages: the subset the two documents use, parsed into
 * typed blocks, and everything outside it refused with the line it is on.
 */
import { describe, expect, it } from 'vitest';

import {
  curlQuotes,
  documentText,
  MarkdownError,
  parseDocument,
  readingMinutes,
  type Inline,
} from './markdown.ts';

/** The proposal's resolver: the other document's file name is the only relative link, and it maps to its page. */
const resolve = (target: string) => (target === 'capability-prediction.md' ? '/about/prediction' : undefined);

const text = (value: string): Inline => ({ kind: 'text', text: value });

/** A document with its title and byline, then `lines`. */
function doc(...lines: string[]): string {
  return ['# A document', '', 'Giovanni Alcantara · October 29, 2026', '', '## A section', '', ...lines, ''].join('\n');
}

/** The error `parseDocument` throws for `markdown`, or null when it parses. */
function refusal(markdown: string): MarkdownError | null {
  try {
    parseDocument(markdown, resolve);
    return null;
  } catch (error) {
    if (error instanceof MarkdownError) return error;
    throw error;
  }
}

describe('the About Markdown reader', () => {
  it('parses_every_construct_the_documents_use', () => {
    const markdown = [
      '# A document',
      '',
      'Giovanni Alcantara · October 29, 2026',
      '',
      '## Who it’s for',
      '',
      'Plain **bold** and `estimate:` with [a source](https://example.com/report)',
      "across a line and [the other one](capability-prediction.md)'s link.",
      '',
      '<!-- figure: architecture -->',
      '![The architecture](images/v1-architecture.svg)',
      '',
      '**Real.**',
      '',
      '- One',
      '- Two with `code`',
      '',
      '| Measure | Prototype |',
      '| --- | --- |',
      '| Baseline | [measured: a rate] |',
      '| Cost | `estimate:` $0.20 |',
      '',
      '<!-- figure: tau3 -->',
      '',
      '<!-- figure: readiness -->',
      '',
    ].join('\n');

    expect(parseDocument(markdown, resolve)).toEqual([
      { kind: 'heading', depth: 1, text: 'A document', id: 'a-document' },
      { kind: 'byline', text: 'Giovanni Alcantara · October 29, 2026' },
      { kind: 'heading', depth: 2, text: 'Who it’s for', id: 'who-its-for' },
      {
        kind: 'paragraph',
        children: [
          text('Plain '),
          { kind: 'strong', children: [text('bold')] },
          text(' and '),
          { kind: 'code', text: 'estimate:' },
          text(' with '),
          { kind: 'link', href: 'https://example.com/report', internal: false, children: [text('a source')] },
          text(' across a line and '),
          { kind: 'link', href: '/about/prediction', internal: true, children: [text('the other one')] },
          text("'s link."),
        ],
      },
      // The image line after the architecture marker is for readers of the repository; the page draws its own.
      { kind: 'figure', name: 'architecture' },
      { kind: 'paragraph', children: [{ kind: 'strong', children: [text('Real.')] }] },
      { kind: 'list', items: [[text('One')], [text('Two with '), { kind: 'code', text: 'code' }]] },
      {
        kind: 'table',
        head: [[text('Measure')], [text('Prototype')]],
        rows: [
          [[text('Baseline')], [{ kind: 'placeholder', text: 'measured: a rate' }]],
          [[text('Cost')], [{ kind: 'code', text: 'estimate:' }, text(' $0.20')]],
        ],
      },
      { kind: 'figure', name: 'tau3' },
      { kind: 'figure', name: 'readiness' },
    ]);
  });

  it('markdown_has_no_html_passthrough', () => {
    // The document around each case parses, so each refusal is the HTML's own.
    expect(refusal(doc('Some text.'))).toBeNull();
    const html = [
      'Some <b>bold</b> text.',
      '<script>alert(1)</script>',
      '<img src="x.png" alt="">',
      'An <img src=x onerror=alert(1)> inline.',
      '<!-- a note -->',
      '<!--\nfigure: tau3\n-->',
      '<!-- figure: pie -->',
      'Text <!-- figure: tau3 --> inline.',
      'See <https://example.com>.',
      'Write to <desk@example.com>.',
      '</p>',
      '<?php echo 1; ?>',
      '| A | B |\n| --- | --- |\n| <b>x</b> | y |',
      '- An <em>item</em>',
    ];
    for (const added of html) {
      const error = refusal(doc('Some text.', '', added));
      expect(error?.reason, added).toBe('raw HTML');
      expect(error?.line, added).toBeGreaterThanOrEqual(9);
    }
    // A figure marker is the one comment, on a line of its own; code spans hold text, which may look like HTML.
    expect(parseDocument(doc('Code such as `<b>` is text.'), resolve).at(-1)).toEqual({
      kind: 'paragraph',
      children: [text('Code such as '), { kind: 'code', text: '<b>' }, text(' is text.')],
    });
    // Angle brackets that open no tag are text, as on GitHub.
    expect(parseDocument(doc('Under 5 < 6 and 3 <= 4.'), resolve).at(-1)).toEqual({
      kind: 'paragraph',
      children: [text('Under 5 < 6 and 3 <= 4.')],
    });
  });

  const BARE_ADDRESS = 'a bare address, which GitHub links; write it as [text](https://…)';

  // Each case is added after the section heading, on line 7; the number is how many lines further down
  // the refusal is. The tools tests (tools/tests/test_docs.py) refuse the common ones without the web toolchain.
  const outsideTheSubset: [string, string, number][] = [
    ['![A chart](images/chart.png)', 'an image other than the architecture figure', 0],
    ['See ![the figure](images/v1-architecture.svg) here.', 'an image other than the architecture figure', 0],
    ['![The architecture](images/v1-architecture.svg)', 'an image other than the architecture figure', 0],
    ['<!-- figure: architecture -->\n\nText.', 'the architecture marker without its image line right after it', 0],
    [
      '<!-- figure: architecture -->\n![The architecture](images/v1-architecture.svg) and more.',
      'the architecture marker without its image line right after it',
      0,
    ],
    [
      '<!-- figure: architecture -->\n![The architecture](images/v1-architecture.svg)\nText right after.',
      'text right after the architecture figure’s image line',
      2,
    ],
    ['### A subsection', 'a heading below ##', 0],
    ['#### Deeper', 'a heading below ##', 0],
    ['# Another title', 'a second # title', 0],
    ['#', 'a second # title', 0],
    ['##', 'an empty heading', 0],
    ['## A **bold** heading', 'a heading with markup', 0],
    ['## A closing sequence ##', 'a heading with markup', 0],
    ['> A quote.', 'a blockquote', 0],
    ['>Quoted with no space.', 'a blockquote', 0],
    ['---', 'a thematic break', 0],
    ['* * *', 'a thematic break', 0],
    ['___', 'a thematic break', 0],
    ['A heading\n=', 'a setext heading underline', 1],
    ['A heading\n---', 'a setext heading underline', 1],
    ['A heading\n--', 'a setext heading underline', 1],
    ['===', 'a setext heading underline', 0],
    ['- One\n  - Nested', 'an indented line', 1],
    ['  #', 'an indented line', 0],
    ['   >Quoted with no space.', 'an indented line', 0],
    ['    indented code', 'an indented line', 0],
    ['Text and\n  an indented line.', 'an indented line', 1],
    ['1. One\n2. Two', 'an ordered list', 0],
    ['1) One', 'an ordered list', 0],
    ['Text and\n1. a list.', 'an ordered list', 1],
    ['* One', 'a list item marked with * or +', 0],
    ['+ One', 'a list item marked with * or +', 0],
    ['- One\n+ Two', 'a list item marked with * or +', 1],
    ['-', 'an empty list item', 0],
    ['```html\n<script>alert(1)</script>\n```', 'a fenced code block', 0],
    ['~~~\n### A subsection\n~~~', 'a fenced code block', 0],
    ['Text and\n```\ncode\n```', 'a fenced code block', 1],
    ['Code such as `a\n<script>alert(1)</script>` is not text.', 'a code span across lines', 0],
    ['- Code such as `a\n<script>alert(1)</script>` is not text.', 'a code span across lines', 0],
    ['Code such as `a\n### A subsection` is not text.', 'a code span that is never closed', 0],
    ['Text with `code', 'a code span that is never closed', 0],
    ['Some *emphasis* here.', 'emphasis other than **bold**', 0],
    ['Some _emphasis_ here.', 'emphasis other than **bold**', 0],
    ['Some ***strong emphasis*** here.', 'emphasis other than **bold**', 0],
    ['Some **bold here.', 'bold that is never closed', 0],
    ['Some ** loose** bold.', 'a ** with a space inside it', 0],
    ['Some **loose ** bold.', 'a ** with a space inside it', 0],
    ['Some **** bold.', 'empty bold', 0],
    ['A \\* star.', 'a backslash escape or line break', 0],
    ['A line break\\\nhere.', 'a backslash escape or line break', 0],
    ['A hard break  \nhere.', 'a hard line break', 0],
    ['- A hard break  \nhere.', 'a hard line break', 0],
    ['Fish &amp; chips.', 'a character reference', 0],
    ['A &#169; sign.', 'a character reference', 0],
    ['Some ~~struck~~ text.', 'a tilde, which GitHub reads as strikethrough', 0],
    ['Some ~struck~ text.', 'a tilde, which GitHub reads as strikethrough', 0],
    ['See [the model].', 'a [ … ] that is neither a link nor a placeholder', 0],
    ['See [the model][ref].', 'a [ … ] that is neither a link nor a placeholder', 0],
    ['[ref]: https://example.com', 'a [ … ] that is neither a link nor a placeholder', 0],
    ['A note.[^1]', 'a [ … ] that is neither a link nor a placeholder', 0],
    ['Some [text with no end.', 'a [ that is never closed', 0],
    ['[a [b] c](https://example.com)', 'a [ inside a link or placeholder', 0],
    ['[a **[b](https://example.com/b)**](https://example.com)', 'a [ inside a link or placeholder', 0],
    ['<!-- figure: tau3 -->\n\n<!-- figure: tau3 -->', 'a figure placed twice', 2],
    ['| A | B |\nNo divider.', 'a table without its | --- | divider row', 1],
    ['| A | B |\n| --- |\n| x | y |', 'a table without its | --- | divider row', 1],
    ['| A | B |\n| --- | --- |\n| x | y | z |', 'a table row with a different number of cells than its header', 2],
    ['| A | B |\n| --- | --- |\n| x |', 'a table row with a different number of cells than its header', 2],
    ['| A | B\n| --- | --- |', 'a table row that doesn’t start and end with |', 0],
    ['Text.\n| A | B |\n| --- | --- |', 'a table without a blank line before it', 1],
    ['| A | B |\n| --- | --- |\nText.', 'a table without a blank line after it', 2],
    ['A | B\n--- | ---', 'a table row that doesn’t start and end with |', 1],
    // GitHub links a bare web or e-mail address that starts a word; the page would show it as plain text.
    ['See https://example.com/report.', BARE_ADDRESS, 0],
    ['See HTTP://EXAMPLE.COM here.', BARE_ADDRESS, 0],
    ['See www.example.com for more.', BARE_ADDRESS, 0],
    ['Write to desk@example.com.', BARE_ADDRESS, 0],
    ['Text and\n(desk+orders@mail.example.co.uk) here.', BARE_ADDRESS, 1],
    ['- An item at https://example.com', BARE_ADDRESS, 0],
    ['| A | B |\n| --- | --- |\n| www.example.com | y |', BARE_ADDRESS, 2],
    ['[owner: www.example.com]', BARE_ADDRESS, 0],
    ['## Write to desk@example.com', BARE_ADDRESS, 0],
  ];

  it('refuses_what_the_reader_subset_leaves_out', () => {
    for (const [added, reason, further] of outsideTheSubset) {
      const error = refusal(doc(added));
      expect(error?.reason, added).toBe(reason);
      expect(error?.line, added).toBe(7 + further);
      expect(error?.message, added).toBe(`line ${7 + further}: ${reason}`);
    }
    // Look-alikes inside the subset: an intraword underscore, an ampersand and a tilde in code, a plain number,
    // addresses as a link's words or in code, which GitHub doesn't link, and words that aren't addresses.
    const inside = [
      'A snake_case word.',
      'Fish & chips.',
      'About `~700` documents.',
      'In 2026, prices rose.',
      'Use $20 ÷ $0.20.',
      'See [www.example.com](https://www.example.com) or [desk@example.com](https://example.com/contact).',
      'Write `desk@example.com` or `https://example.com` in code.',
      'An @ alone, 5@6 and awww.example are words.',
    ];
    for (const line of inside) expect(refusal(doc(line)), line).toBeNull();
  });

  it('links_resolve_to_https_or_the_other_document', () => {
    const lastBlock = (line: string) => parseDocument(doc(line), resolve).at(-1);
    expect(lastBlock('See [a source](https://example.com/report?a=1#b).')).toEqual({
      kind: 'paragraph',
      children: [
        text('See '),
        { kind: 'link', href: 'https://example.com/report?a=1#b', internal: false, children: [text('a source')] },
        text('.'),
      ],
    });
    // The other document's file name becomes its page's route, as the resolver says.
    expect(lastBlock('See the [capability prediction](capability-prediction.md).')).toEqual({
      kind: 'paragraph',
      children: [
        text('See the '),
        { kind: 'link', href: '/about/prediction', internal: true, children: [text('capability prediction')] },
        text('.'),
      ],
    });
    // A target may hold balanced parentheses, and the text bold and code.
    expect(lastBlock('[**Bold** and `code`](https://en.wikipedia.org/wiki/Desk_(furniture))')).toEqual({
      kind: 'paragraph',
      children: [
        {
          kind: 'link',
          href: 'https://en.wikipedia.org/wiki/Desk_(furniture)',
          internal: false,
          children: [{ kind: 'strong', children: [text('Bold')] }, text(' and '), { kind: 'code', text: 'code' }],
        },
      ],
    });

    const neither = (target: string) => `a link to ${target}, neither https:// nor the other document`;
    const refused: [string, string][] = [
      ['See [the proposal](product-proposal.md).', neither('product-proposal.md')],
      ['See [the threat model](threat-model.md).', neither('threat-model.md')],
      ['See [the readiness](capability-prediction.md#readiness).', neither('capability-prediction.md#readiness')],
      ['See [the prediction](./capability-prediction.md).', neither('./capability-prediction.md')],
      ['See [the figure](images/v1-architecture.svg).', neither('images/v1-architecture.svg')],
      ['See [a page](http://example.com).', neither('http://example.com')],
      ['See [a page](//example.com).', neither('//example.com')],
      ['See [a page](HTTPS://EXAMPLE.COM).', neither('HTTPS://EXAMPLE.COM')],
      ['Write [to us](mailto:desk@example.com).', neither('mailto:desk@example.com')],
      ['Run [this](javascript:alert(1)).', neither('javascript:alert(1)')],
      ['See [nothing]().', neither('')],
      ['See [a page](https://example.com "A title").', 'a link title or a space in a link target'],
      ['See [a page](https://example.com\nmore).', 'a link title or a space in a link target'],
      ['See [a page](https://example.com.', 'a link target that is never closed'],
      ['See [](https://example.com).', 'a link without text'],
    ];
    for (const [line, reason] of refused) expect(refusal(doc(line))?.message, line).toBe(`line 7: ${reason}`);
  });

  it('placeholders_parse_as_placeholders', () => {
    const markdown = doc(
      '[measured: tier 2 pass, with its 95% upper bound]; the gate requires 0.',
      '',
      'It is at [owner: hosted URL; the passcode comes with the link], **[owner: repo link]** and [measured: a',
      'rate].',
      '',
      '| Measure | Prototype |',
      '| --- | --- |',
      '| Cost | `estimate:` $0.20; [measured: …] |',
    );
    const placeholder = (value: string): Inline => ({ kind: 'placeholder', text: value });
    expect(parseDocument(markdown, resolve).slice(3)).toEqual([
      { kind: 'paragraph', children: [placeholder('measured: tier 2 pass, with its 95% upper bound'), text('; the gate requires 0.')] },
      {
        kind: 'paragraph',
        children: [
          text('It is at '),
          placeholder('owner: hosted URL; the passcode comes with the link'),
          text(', '),
          { kind: 'strong', children: [placeholder('owner: repo link')] },
          text(' and '),
          placeholder('measured: a rate'),
          text('.'),
        ],
      },
      {
        kind: 'table',
        head: [[text('Measure')], [text('Prototype')]],
        rows: [[[text('Cost')], [{ kind: 'code', text: 'estimate:' }, text(' $0.20; '), placeholder('measured: …')]]],
      },
    ]);
    // Filled, a placeholder's place holds a link, whatever its words.
    expect(parseDocument(doc('[owner: repo](https://github.com/example/claude-desk)'), resolve).at(-1)).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'link', href: 'https://github.com/example/claude-desk', internal: false, children: [text('owner: repo')] }],
    });
    // Only the two kinds, written as the documents write them, with plain text.
    for (const line of ['[measured:x]', '[Measured: x]', '[todo: x]', '[owner: **x**]', '[owner:]']) {
      expect(refusal(doc(line))?.message, line).toBe('line 7: a [ … ] that is neither a link nor a placeholder');
    }
  });

  it('document_text_reads_the_article_in_order', () => {
    const markdown = doc(
      'A **bold** start, `estimate:` and [a link](https://example.com) with [owner: repo link].',
      '',
      '<!-- figure: architecture -->',
      '![The architecture](images/v1-architecture.svg)',
      '',
      '- One',
      '- Two',
      '',
      '| Axis | Readiness |',
      '| --- | --- |',
      '| Apply policies | Near |',
      '| Negotiate | Early |',
      '',
      '## Another section',
    );
    // The title and the byline feed the hero and the meta column, and figures and the image line add no text.
    expect(documentText(parseDocument(markdown, resolve))).toEqual([
      'A section',
      'A bold start, estimate: and a link with owner: repo link.',
      'One',
      'Two',
      'Axis',
      'Readiness',
      'Apply policies',
      'Near',
      'Negotiate',
      'Early',
      'Another section',
    ]);
  });

  it('heading_ids_are_unique_anchors', () => {
    const blocks = parseDocument(doc('## A section', '', '## A document', '', '## Why it’s 80%: v1 & τ³'), resolve);
    expect(blocks.flatMap((block) => (block.kind === 'heading' ? [block.id] : []))).toEqual([
      'a-document',
      'a-section',
      'a-section-2',
      'a-document-2',
      'why-its-80-v1',
    ]);
  });

  it('reading_time_is_computed', () => {
    // The article's words at 230 a minute, rounded, and never under a minute. "A section" adds two words.
    const withWords = (count: number, title = 'A document') =>
      parseDocument(doc(Array.from({ length: count }, () => 'word').join(' ')).replace('A document', title), resolve);
    for (const count of [0, 10, 228, 342, 343, 688, 1000]) {
      expect(readingMinutes(withWords(count)), `${count} words`).toBe(Math.max(1, Math.round((count + 2) / 230)));
    }
    expect(readingMinutes(withWords(342))).toBe(1);
    expect(readingMinutes(withWords(343))).toBe(2);
    // The title and the byline aren't the article.
    expect(readingMinutes(withWords(342, Array.from({ length: 200 }, () => 'title').join(' ')))).toBe(1);
  });

  it('a_document_starts_with_its_title_and_byline', () => {
    const title = 'a document starts with its # title';
    const byline = 'the byline, “Name · Month D, YYYY”, follows the title';
    expect(refusal('')?.message).toBe(`line 1: ${title}`);
    expect(refusal('Giovanni Alcantara · October 29, 2026\n\n## A section\n')?.message).toBe(`line 1: ${title}`);
    expect(refusal('## A section\n\n# A document\n')?.message).toBe(`line 1: ${title}`);
    expect(refusal('# A document\n\n## A section\n')?.message).toBe(`line 3: ${byline}`);
    expect(refusal('# A document\n\nNot a byline.\n')?.message).toBe(`line 3: ${byline}`);
    expect(refusal('# A document\n\nGiovanni Alcantara · October 29, 2026\nand more.\n')?.message).toBe(`line 3: ${byline}`);
    expect(refusal('# A document\n')?.message).toBe(`line 2: ${byline}`);
    // The title is plain text, as the sections' headings are.
    const after = '\n\nGiovanni Alcantara · October 29, 2026\n';
    expect(refusal(`# A **bold** document${after}`)?.message).toBe('line 1: a heading with markup');
    expect(refusal(`# A document #${after}`)?.message).toBe('line 1: a heading with markup');
    expect(parseDocument('\n# A document\nGiovanni Alcantara · October 29, 2026\n', resolve)).toEqual([
      { kind: 'heading', depth: 1, text: 'A document', id: 'a-document' },
      { kind: 'byline', text: 'Giovanni Alcantara · October 29, 2026' },
    ]);
  });

  it('quote_marks_show_curly_on_the_page', () => {
    const markdown = [
      "# The owner's document",
      '',
      "Giovanni O'Brien · October 29, 2026",
      '',
      "## Who it's for",
      '',
      `The owner's rules and owners' changes; "the gap between 'capable' and 'completely robust'" in the '90s.`,
      '',
      `He wrote "'Hi,' she said" and a "[quoted link](https://example.com/q)".`,
      '',
      "**Who's asking.** A [visitor's page](https://example.com/pricing)'s $20, `it's \"code\"` and [owner: the owner's word].",
      '',
      "- It's listed",
      '',
      '| Axis | Note |',
      '| --- | --- |',
      "| 'Quoted' | (the 'aside') |",
      '',
    ].join('\n');
    const blocks = parseDocument(markdown, resolve);
    expect(curlQuotes(blocks)).toEqual([
      { kind: 'heading', depth: 1, text: 'The owner’s document', id: 'the-owners-document' },
      { kind: 'byline', text: 'Giovanni O’Brien · October 29, 2026' },
      { kind: 'heading', depth: 2, text: 'Who it’s for', id: 'who-its-for' },
      {
        kind: 'paragraph',
        children: [
          text('The owner’s rules and owners’ changes; “the gap between ‘capable’ and ‘completely robust’” in the ’90s.'),
        ],
      },
      {
        kind: 'paragraph',
        children: [
          text('He wrote “‘Hi,’ she said” and a “'),
          { kind: 'link', href: 'https://example.com/q', children: [text('quoted link')], internal: false },
          text('”.'),
        ],
      },
      {
        kind: 'paragraph',
        children: [
          { kind: 'strong', children: [text('Who’s asking.')] },
          text(' A '),
          { kind: 'link', href: 'https://example.com/pricing', children: [text('visitor’s page')], internal: false },
          // After a link, a quote mark closes the link's last word.
          text('’s $20, '),
          // Code keeps what was typed.
          { kind: 'code', text: `it's "code"` },
          text(' and '),
          { kind: 'placeholder', text: 'owner: the owner’s word' },
          text('.'),
        ],
      },
      { kind: 'list', items: [[text('It’s listed')]] },
      {
        kind: 'table',
        head: [[text('Axis')], [text('Note')]],
        rows: [[[text('‘Quoted’')], [text('(the ‘aside’)')]]],
      },
    ]);
    // The parse itself is left as the Markdown has it.
    expect(blocks[2]).toEqual({ kind: 'heading', depth: 2, text: "Who it's for", id: 'who-its-for' });
  });
});
