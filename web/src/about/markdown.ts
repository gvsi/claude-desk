/**
 * The Markdown reader for the About this prototype pages. It reads the small subset the product proposal and
 * the capability prediction use (docs/AGENTS.md lists it) into typed blocks that the page renders as React
 * elements. No HTML passes through: anything outside the subset, and anything GitHub would render differently
 * from this reader, throws a `MarkdownError` naming its line, so a document the page can't show as written
 * fails its tests instead of reaching the page.
 */
import { slug } from './anchors.ts';
import { minutesToRead, wordCount } from './readTime.ts';

/** Text inside a block. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'code'; text: string }
  /** `internal` links go to the other document's page; the rest are `https://` addresses. */
  | { kind: 'link'; href: string; children: Inline[]; internal: boolean }
  /** `[measured: …]` or `[owner: …]`, kept visible until the document is filled. */
  | { kind: 'placeholder'; text: string };

/** The three figures a document can place with `<!-- figure: name -->`. */
export type FigureName = 'architecture' | 'tau3' | 'readiness';

export type Block =
  | { kind: 'heading'; depth: 1 | 2; text: string; id: string }
  | { kind: 'byline'; text: string }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'figure'; name: FigureName };

/** Maps a relative link target to a page route, or returns undefined when the target isn't one the page links. */
export type LinkResolver = (target: string) => string | undefined;

/** Something in a document outside the reader's subset, with the line it is on when there is one. */
export class MarkdownError extends Error {
  readonly line: number | null;
  readonly reason: string;

  constructor(line: number | null, reason: string, file?: string) {
    const where = [file, line === null ? undefined : `line ${line}`].filter(Boolean).join(' ');
    super(where ? `${where}: ${reason}` : reason);
    this.name = 'MarkdownError';
    this.line = line;
    this.reason = reason;
  }
}

const TITLE = /^#[ \t]+\S/;
const BYLINE = /^[^·*_`[\]<>\\&]+ · [A-Z][a-z]+ \d{1,2}, \d{4}$/;
const HEADING = /^(#+)(?:[ \t]+(.*))?$/;
const FIGURE = /^<!-- figure: (architecture|tau3|readiness) -->$/;
// The architecture figure's committed SVG, for readers of the repository, on the line right after its marker.
const FIGURE_IMAGE = /^!\[[^[\]\n]+\]\(images\/v1-architecture\.svg\)$/;
const BULLET = /^-[ \t]+(\S.*)$/;
const TABLE_ROW = /^\|/;
const DIVIDER_CELL = /^:?-+:?$/;
const PLACEHOLDER = /^(?:measured|owner): /;
const CHARACTER_REFERENCE = /^&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
// A web or e-mail address at the start of a word, which GitHub links though no one wrote a link. Sticky: each is
// tried at one place in the text.
const BARE_ADDRESSES = [/(?:https?:\/\/|www\.)/iy, /[\w.+-]+@[\w-]+\.[\w.-]+/y];
const BARE_ADDRESS = 'a bare address, which GitHub links; write it as [text](https://…)';

/** Whether a bare address starts at `index` in `text`, at the start of a word. */
function startsBareAddress(text: string, index: number): boolean {
  return (
    !WORD_CHARACTER.test(text[index - 1] ?? '') &&
    BARE_ADDRESSES.some((pattern) => {
      pattern.lastIndex = index;
      return pattern.test(text);
    })
  );
}

// Lines that start a construct outside the subset, checked in this order wherever a line can start a block.
const OUTSIDE: [RegExp, string][] = [
  [/^[ \t]/, 'an indented line'],
  [/^(?:`{3,}|~{3,})/, 'a fenced code block'],
  [/^>/, 'a blockquote'],
  [/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/, 'a thematic break'],
  [/^-[ \t]*$/, 'an empty list item'],
  [/^(?:=+|-+)[ \t]*$/, 'a setext heading underline'],
  [/^\d{1,9}[.)](?:[ \t]|$)/, 'an ordered list'],
  [/^[*+](?:[ \t]|$)/, 'a list item marked with * or +'],
];

function outside(line: string): string | undefined {
  return OUTSIDE.find(([pattern]) => pattern.test(line))?.[1];
}

/** Reads one block's text, `source` holding its lines joined by newlines and starting on line `firstLine`. */
function parseInlines(source: string, firstLine: number, resolve: LinkResolver): Inline[] {
  let at = 0;
  let inBrackets = false;
  /** Where the first bare address inside the open brackets starts, refused unless they turn out to be a link. */
  let bareInBrackets: number | null = null;
  const fail = (index: number, reason: string): never => {
    throw new MarkdownError(firstLine + (source.slice(0, index).match(/\n/g)?.length ?? 0), reason);
  };
  const isSpace = (index: number) => /^\s?$/.test(source[index] ?? '');

  function run(until: '**' | ']' | null): Inline[] {
    const start = at;
    const out: Inline[] = [];
    let pending = '';
    const flush = () => {
      if (pending) out.push({ kind: 'text', text: pending.replace(/\n/g, ' ') });
      pending = '';
    };
    while (at < source.length) {
      const char = source[at] ?? '';
      const next = source[at + 1] ?? '';
      if (until === '**' && source.startsWith('**', at)) {
        if (at === start) fail(start - 2, 'empty bold');
        if (isSpace(at - 1)) fail(at, 'a ** with a space inside it');
        at += 2;
        flush();
        return out;
      }
      if (until === ']' && char === ']') {
        at += 1;
        flush();
        return out;
      }
      if (char === '`') {
        flush();
        out.push(codeSpan());
      } else if (source.startsWith('**', at)) {
        if (source[at + 2] === '*' && source[at + 3] !== '*') fail(at, 'emphasis other than **bold**');
        if (isSpace(at + 2)) fail(at, 'a ** with a space inside it');
        at += 2;
        flush();
        out.push({ kind: 'strong', children: run('**') });
      } else if (char === '*') {
        fail(at, 'emphasis other than **bold**');
      } else if (char === '_' && !(WORD_CHARACTER.test(source[at - 1] ?? '') && WORD_CHARACTER.test(next))) {
        fail(at, 'emphasis other than **bold**');
      } else if (char === '[') {
        if (inBrackets) fail(at, 'a [ inside a link or placeholder');
        flush();
        out.push(bracket());
      } else if (char === '!' && next === '[') {
        fail(at, 'an image other than the architecture figure');
      } else if (char === '<' && /[A-Za-z!/?]/.test(next)) {
        // A tag, a comment, a declaration or an angle-bracket link. Only the figure markers, each on a line
        // of its own, are read, and they never reach this.
        fail(at, 'raw HTML');
      } else if (char === '\\') {
        fail(at, 'a backslash escape or line break');
      } else if (char === '&' && CHARACTER_REFERENCE.test(source.slice(at))) {
        fail(at, 'a character reference');
      } else if (char === '~') {
        fail(at, 'a tilde, which GitHub reads as strikethrough');
      } else {
        if (startsBareAddress(source, at)) {
          // GitHub links it anywhere but in a link's words, which brackets hold until a ( follows them.
          if (!inBrackets) fail(at, BARE_ADDRESS);
          bareInBrackets ??= at;
        }
        pending += char;
        at += 1;
      }
    }
    if (until === '**') fail(start - 2, 'bold that is never closed');
    if (until === ']') fail(start - 1, 'a [ that is never closed');
    flush();
    return out;
  }

  function codeSpan(): Inline {
    const ticks = /^`+/.exec(source.slice(at))?.[0] ?? '`';
    const close = new RegExp(`(?<!\`)${ticks}(?!\`)`, 'g');
    close.lastIndex = at + ticks.length;
    const end = close.exec(source);
    if (!end) return fail(at, 'a code span that is never closed');
    const text = source.slice(at + ticks.length, end.index);
    if (text.includes('\n')) fail(at, 'a code span across lines');
    at = end.index + ticks.length;
    return { kind: 'code', text: /^ .*[^ ].* $/.test(text) ? text.slice(1, -1) : text };
  }

  function bracket(): Inline {
    const open = at;
    at += 1;
    inBrackets = true;
    bareInBrackets = null;
    const children = run(']');
    inBrackets = false;
    if (source[at] === '(') return link(open, children);
    // Brackets that aren't a link are text to GitHub, which links an address in them.
    if (bareInBrackets !== null) fail(bareInBrackets, BARE_ADDRESS);
    const only = children.length === 1 ? children[0] : undefined;
    if (only?.kind === 'text' && PLACEHOLDER.test(only.text)) return { kind: 'placeholder', text: only.text };
    return fail(open, 'a [ … ] that is neither a link nor a placeholder');
  }

  function link(open: number, children: Inline[]): Inline {
    let depth = 0;
    let end = at + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '(') depth += 1;
      else if (char === ')' && depth-- === 0) break;
    }
    if (end >= source.length) fail(open, 'a link target that is never closed');
    const target = source.slice(at + 1, end);
    if (/\s/.test(target)) fail(open, 'a link title or a space in a link target');
    if (children.length === 0) fail(open, 'a link without text');
    at = end + 1;
    if (target.startsWith('https://')) return { kind: 'link', href: target, children, internal: false };
    const route = resolve(target);
    if (route !== undefined) return { kind: 'link', href: route, children, internal: true };
    return fail(open, `a link to ${target}, neither https:// nor the other document`);
  }

  return run(null);
}

/** The words of a run of inlines, as the page shows them. */
export function inlineText(inlines: Inline[]): string {
  return inlines
    .map((inline) => ('children' in inline ? inlineText(inline.children) : inline.text))
    .join('');
}

/**
 * The article's text in order, one string per piece the page marks: each `##` heading, paragraph and list item,
 * and each table's header cells once followed by its rows' cells, row by row. The `#` title and the byline feed
 * the hero and the meta column instead, and figure markers and the architecture image line add nothing.
 */
export function documentText(blocks: Block[]): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.kind) {
      case 'heading':
        return block.depth === 2 ? [block.text] : [];
      case 'paragraph':
        return [inlineText(block.children)];
      case 'list':
        return block.items.map(inlineText);
      case 'table':
        return [...block.head, ...block.rows.flat()].map(inlineText);
      case 'byline':
      case 'figure':
        return [];
    }
  });
}

/** Each straight quote mark's curly pair: the one that opens a quotation, then the one for everywhere else. */
const CURLY: Partial<Record<string, readonly [string, string]>> = { "'": ['‘', '’'], '"': ['“', '”'] };
// A quote mark with nothing shown before it, or after a space, an opening bracket or an opening quote, opens a
// quotation unless a space follows it.
const OPENS_AFTER = /^$|[\s([{“‘]/;
// After a dash, a hyphen, an ellipsis or a slash a mark can as well close a quotation, so there it opens only
// when words follow, not a space, punctuation or the end of the block.
const OPENS_AFTER_JOIN = /[—–…/-]/;
const CLOSES_BEFORE = /^(?:$|[\s.,;:!?)\]}”’])/;
// What follows a ' that starts a word but is an apostrophe: a whole leading elision such as ’til, ’em or rock
// ’n’ roll, or a year such as ’90s or ’26, but not a quoted word or number such as ‘em-dash’, ‘N/A’, ‘26’, ‘24/7’
// or ‘24.7%’.
const ELISION =
  /^(?:(?:til|em|cause|tis|twas)(?![\p{L}\p{N}'’-])|n['’](?![\p{L}\p{N}])|\d\d(?:s(?![\p{L}\p{N}])|(?![\p{L}\p{N}%'’/:]|[.,]\d)))/iu;

/**
 * `text` with its straight quote marks curled, `before` being the character the page shows just ahead of it and
 * `after` the words that follow it in the same block.
 */
function curl(text: string, before: string, after = ''): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    const pair = CURLY[char];
    if (!pair) {
      out += char;
      continue;
    }
    const rest = text.slice(at + 1) + after;
    const shownBefore = out.at(-1) ?? before;
    const opensHere = OPENS_AFTER.test(shownBefore)
      ? !/^\s/.test(rest)
      : OPENS_AFTER_JOIN.test(shownBefore) && !CLOSES_BEFORE.test(rest);
    const opens = opensHere && !(char === "'" && ELISION.test(rest));
    out += opens ? pair[0] : pair[1];
  }
  return out;
}

/** A block's inlines with their quote marks curled, each piece read between what the page shows around it. */
function curlRun(inlines: Inline[]): Inline[] {
  // The pieces of words in reading order, through bold and links.
  const leaves: Extract<Inline, { text: string }>[] = [];
  const collect = (pieces: Inline[]) => {
    for (const inline of pieces) {
      if ('children' in inline) collect(inline.children);
      else leaves.push(inline);
    }
  };
  collect(inlines);
  const shown = new Map<Inline, Inline>();
  let last = '';
  leaves.forEach((leaf, i) => {
    const after = leaves
      .slice(i + 1)
      .map((next) => next.text)
      .join('');
    const curled = leaf.kind === 'code' ? leaf : { ...leaf, text: curl(leaf.text, last, after) };
    last = curled.text.at(-1) ?? last;
    shown.set(leaf, curled);
  });
  const rebuild = (pieces: Inline[]): Inline[] =>
    pieces.map((inline) =>
      'children' in inline ? { ...inline, children: rebuild(inline.children) } : (shown.get(inline) ?? inline),
    );
  return rebuild(inlines);
}

/**
 * The blocks as the page shows them, with typographic quote marks in place of the Markdown's straight `'` and
 * `"`, as the page's own words write them: ‘ and “ where one opens a quotation, ’ and ” everywhere else, so an
 * apostrophe or an elision such as ’til or ’90s is ’. Code keeps what was typed, and the Markdown on disk is
 * unchanged.
 */
export function curlQuotes(blocks: Block[]): Block[] {
  return blocks.map((block): Block => {
    switch (block.kind) {
      case 'heading':
      case 'byline':
        return { ...block, text: curl(block.text, '') };
      case 'paragraph':
        return { ...block, children: curlRun(block.children) };
      case 'list':
        return { ...block, items: block.items.map(curlRun) };
      case 'table':
        return { ...block, head: block.head.map(curlRun), rows: block.rows.map((row) => row.map(curlRun)) };
      case 'figure':
        return block;
    }
  });
}

/** Minutes to read the article: its words at the About pages' speed (`readTime.ts`), rounded, and at least one. */
export function readingMinutes(blocks: Block[]): number {
  return minutesToRead(wordCount(documentText(blocks)));
}

/**
 * Parses a document: its `#` title, the byline line under it, then `##` sections of paragraphs, one-level `-`
 * lists, tables and figure markers. `resolve` maps the one relative link a document may hold, the other
 * document's file name, to that document's page.
 */
export function parseDocument(markdown: string, resolve: LinkResolver): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const anchors = new Set<string>();
  /** A heading's anchor, unique in the page: a repeated one gains -2, -3 and so on. */
  const anchor = (text: string) => {
    const base = slug(text);
    let id = base;
    for (let count = 2; anchors.has(id); count += 1) id = `${base}-${count}`;
    anchors.add(id);
    return id;
  };
  const lineAt = (n: number) => lines[n] ?? '';
  const blank = (n: number) => lineAt(n).trim() === '';
  const fail = (n: number, reason: string): never => {
    throw new MarkdownError(n + 1, reason);
  };

  /** Text running over lines `from` to `to`: no hard line breaks, and trailing spaces dropped at each break. */
  function textOf(from: number, to: number, first = lineAt(from)): Inline[] {
    const parts = [first, ...lines.slice(from + 1, to)];
    parts.slice(0, -1).forEach((part, i) => {
      if (/ {2,}$/.test(part)) fail(from + i, 'a hard line break');
    });
    return parseInlines(parts.map((part) => part.trimEnd()).join('\n'), from + 1, resolve);
  }

  /** Where the text that starts on line `n` ends: at a blank line or a line that starts a block. */
  function textEnd(n: number, inParagraph: boolean): number {
    let end = n + 1;
    for (; end < lines.length && !blank(end); end += 1) {
      const line = lineAt(end);
      if (inParagraph && /^(?:=+|-+)[ \t]*$/.test(line)) fail(end, 'a setext heading underline');
      const reason = outside(line);
      if (reason) fail(end, reason);
      if (TABLE_ROW.test(line)) fail(end, 'a table without a blank line before it');
      if (line.includes('|') && cells(`|${line}|`).every((cell) => DIVIDER_CELL.test(cell))) {
        fail(end, 'a table row that doesn’t start and end with |');
      }
      if (HEADING.test(line) || FIGURE.test(line) || BULLET.test(line)) break;
    }
    return end;
  }

  /** A heading's words on line `n`: plain text, with no markup and no closing `#`s. */
  function headingText(n: number, content: string): string {
    const parsed = parseInlines(content.trim(), n + 1, resolve);
    if (parsed.length === 0) fail(n, 'an empty heading');
    const only = parsed.length === 1 ? parsed[0] : undefined;
    if (only?.kind !== 'text' || /(?:^|[ \t])#+$/.test(only.text)) return fail(n, 'a heading with markup');
    return only.text;
  }

  function cells(line: string): string[] {
    return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
  }

  function row(n: number): string[] {
    const line = lineAt(n).trim();
    if (!line.startsWith('|') || !line.endsWith('|') || line.length < 2) {
      fail(n, 'a table row that doesn’t start and end with |');
    }
    return cells(line);
  }

  let n = 0;
  while (n < lines.length && blank(n)) n += 1;
  if (!TITLE.test(lineAt(n))) fail(Math.min(n, lines.length - 1), 'a document starts with its # title');
  const title = headingText(n, lineAt(n).replace(/^#[ \t]+/, ''));
  blocks.push({ kind: 'heading', depth: 1, text: title, id: anchor(title) });
  n += 1;
  while (n < lines.length && blank(n)) n += 1;
  if (!BYLINE.test(lineAt(n).trim()) || !blank(n + 1)) {
    fail(Math.min(n, lines.length - 1), 'the byline, “Name · Month D, YYYY”, follows the title');
  }
  const byline = lineAt(n).trim();
  // GitHub links a bare address in the byline as anywhere else.
  // Every offset in the line, as the address check counts them, however many characters take two.
  if (Array.from({ length: byline.length }, (_, at) => at).some((at) => startsBareAddress(byline, at))) {
    fail(n, BARE_ADDRESS);
  }
  blocks.push({ kind: 'byline', text: byline });
  n += 1;

  while (n < lines.length) {
    const line = lineAt(n);
    if (blank(n)) {
      n += 1;
      continue;
    }
    const reason = outside(line);
    if (reason) fail(n, reason);
    const heading = HEADING.exec(line);
    const figure = FIGURE.exec(line);
    const bullet = BULLET.exec(line);
    if (heading) {
      const hashes = (heading[1] ?? '').length;
      if (hashes === 1) fail(n, 'a second # title');
      if (hashes > 2) fail(n, 'a heading below ##');
      const text = headingText(n, heading[2] ?? '');
      blocks.push({ kind: 'heading', depth: 2, text, id: anchor(text) });
      n += 1;
    } else if (figure) {
      const name = figure[1] as FigureName;
      if (blocks.some((block) => block.kind === 'figure' && block.name === name)) fail(n, 'a figure placed twice');
      blocks.push({ kind: 'figure', name });
      n += 1;
      if (name === 'architecture') {
        if (!FIGURE_IMAGE.test(lineAt(n))) fail(n - 1, 'the architecture marker without its image line right after it');
        if (n + 1 < lines.length && !blank(n + 1)) fail(n + 1, 'text right after the architecture figure’s image line');
        n += 1;
      }
    } else if (bullet) {
      const items: Inline[][] = [];
      while (n < lines.length && BULLET.test(lineAt(n))) {
        const end = textEnd(n, false);
        items.push(textOf(n, end, BULLET.exec(lineAt(n))?.[1] ?? ''));
        n = end;
      }
      blocks.push({ kind: 'list', items });
    } else if (TABLE_ROW.test(line)) {
      const head = row(n).map((cell) => parseInlines(cell, n + 1, resolve));
      const divider = n + 1 < lines.length && TABLE_ROW.test(lineAt(n + 1)) ? row(n + 1) : [];
      if (divider.length !== head.length || !divider.every((cell) => DIVIDER_CELL.test(cell))) {
        fail(n + 1, 'a table without its | --- | divider row');
      }
      n += 2;
      const rows: Inline[][][] = [];
      for (; n < lines.length && !blank(n); n += 1) {
        if (!TABLE_ROW.test(lineAt(n))) fail(n, 'a table without a blank line after it');
        const cellsOfRow = row(n);
        if (cellsOfRow.length !== head.length) fail(n, 'a table row with a different number of cells than its header');
        rows.push(cellsOfRow.map((cell) => parseInlines(cell, n + 1, resolve)));
      }
      blocks.push({ kind: 'table', head, rows });
    } else {
      const end = textEnd(n, true);
      blocks.push({ kind: 'paragraph', children: textOf(n, end) });
      n = end;
    }
  }
  return blocks;
}
