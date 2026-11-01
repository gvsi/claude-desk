import { createElement, type JSX, useLayoutEffect, useRef } from 'react';
import { harden } from 'rehype-harden';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { type Components, defaultRemarkPlugins, type ExtraProps, parseMarkdownIntoBlocks, Streamdown, type StreamdownProps } from 'streamdown';

import { everyTableCell } from './everyTableCell.ts';
import { footnotesAsText } from './footnotesAsText.ts';
import { linksAsText } from './linksAsText.ts';
import { taskItemsAsText } from './taskItemsAsText.ts';
import { useReducedMotion } from './useReducedMotion.ts';
import { useReveal } from './useReveal.ts';

import './ChatMarkdown.css';

/**
 * What runs on the rendered Markdown, in place of Streamdown's defaults. `rehype-raw` is left out,
 * so HTML in the text stays text: Streamdown then turns each HTML node into its words. The
 * sanitizer keeps GitHub's safe elements and lets links point only at http, https and mailto, and
 * hardening turns every image into its alt text and every link it refuses into its link text.
 */
const REHYPE_PLUGINS: StreamdownProps['rehypePlugins'] = [
  [rehypeSanitize, { ...defaultSchema, protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] } }],
  [
    harden,
    {
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowedProtocols: [],
      linkBlockPolicy: 'text-only',
      imageBlockPolicy: 'text-only',
    },
  ],
];

/**
 * Streamdown's own Markdown steps (GitHub Markdown and code fences), then footnotes and task items
 * back to their words, and every table cell kept.
 */
const SHARED_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), footnotesAsText, taskItemsAsText, everyTableCell];

/** Each `links` setting's Markdown steps: inert links become their words and address as written. */
const REMARK_PLUGINS: Record<NonNullable<ChatMarkdownProps['links']>, StreamdownProps['remarkPlugins']> = {
  open: SHARED_REMARK_PLUGINS,
  inert: [...SHARED_REMARK_PLUGINS, linksAsText],
};

/** A reference definition, `[1]: https://…`, which may sit in its own paragraph, a quote or an indented list item. */
const REFERENCE_DEFINITION = /^[ \t>]*\[[^\]]+\]:/m;

/**
 * Streamdown renders a reply block by block, so a reference definition in its own paragraph
 * would vanish and its link show as `[Book][1]`, losing the address. A reply that defines a
 * reference renders as one block, as Streamdown already does for footnotes.
 */
function blocksOf(markdown: string): string[] {
  return REFERENCE_DEFINITION.test(markdown) ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

/**
 * A hard break is one `<br>`. By default a newline follows it too, which the paragraph's
 * `pre-line`, there to keep Claude's own line breaks, would draw as a second, blank line.
 */
const TO_HTML: StreamdownProps['remarkRehypeOptions'] = {
  handlers: { break: () => ({ type: 'element', tagName: 'br', properties: {}, children: [] }) },
};

export interface ChatMarkdownProps {
  /** Claude's reply as Markdown: the whole text so far. It may grow between renders and may stop mid-token. */
  text: string;
  /** The text is still growing (owner chats mid-stream): unfinished syntax is closed, and new words settle in over 150 ms. Default false. */
  streaming?: boolean;
  /** Visitor reveal: `text` is whole; reveal it word by word (about 200 chars/s, at most about 3 s). Default false. */
  reveal?: boolean;
  /**
   * With `reveal`, when `text` is one of several blocks of a reply revealed one after another: the
   * whole reply's length, which sets the pace, so the reply takes at most about 3 s in all. Default:
   * the length of `text`.
   */
  revealLength?: number;
  /** Called once when everything in `text` is shown (at once when not revealing, or with reduce-motion on). */
  onRevealed?: () => void;
  /**
   * 'inert' (default): link text, then its address as written, not clickable. For stopped drafts, and
   * for ClaudeMessage's prose until the kernel's reply check reads Markdown links (its `PROSE_LINKS`).
   * 'open': links clickable, text only, where a screen asks for it, as setup's docked question does.
   */
  links?: 'open' | 'inert';
}

type ElementProps<Tag extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[Tag] & ExtraProps;

/** The element itself, without Streamdown's own classes, controls or wrappers. */
function plain<Tag extends keyof JSX.IntrinsicElements>(tag: Tag) {
  function Plain({ node: _node, ...props }: ElementProps<Tag>) {
    return createElement(tag, props);
  }
  Plain.displayName = `ChatMarkdown.${tag}`;
  return Plain;
}

/** A table's header cells' words, as "Repair, Replace", or nothing when its header has none. */
function headerWords(table: ExtraProps['node']): string {
  const head = table?.children.find((child) => child.type === 'element' && child.tagName === 'thead');
  const row = head?.type === 'element' ? head.children.find((child) => child.type === 'element' && child.tagName === 'tr') : undefined;
  if (row?.type !== 'element') return '';
  return row.children
    .flatMap((cell) => (cell.type === 'element' ? [textOf(cell).trim()] : []))
    .filter((words) => words !== '')
    .join(', ');
}

/**
 * A table in its hairline card, which scrolls sideways when the table is wider than the column. It
 * takes focus, so a keyboard can scroll it (Safari scrolls only what has focus), and with header
 * words it is a region named by them.
 */
function Table({ node, ...props }: ElementProps<'table'>) {
  const label = headerWords(node);
  return (
    <div className="cd-md__table" tabIndex={0} {...(label === '' ? {} : { role: 'region', 'aria-label': label })}>
      <table {...props} />
    </div>
  );
}

/** The only places a link may go. */
const LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

/** `href` when it is a whole URL to http, https or mailto; null for anything else, a page's own paths included. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    return LINK_PROTOCOLS.includes(new URL(href).protocol) ? href : null;
  } catch {
    // Not a whole URL: a path on this page, or no address at all.
    return null;
  }
}

/** The words inside a rendered element, as a reader sees them. */
function textOf(node: ExtraProps['node']): string {
  if (node === undefined) return '';
  return node.children.map((child) => (child.type === 'text' ? child.value : child.type === 'element' ? textOf(child) : '')).join('');
}

/**
 * Where a link goes: its safe `href`, except that a bare `www.` address opens as https. GitHub
 * Markdown links `www.example.com` to http, but the reply check reads a visible `www.` address as
 * https, so the visitor goes where it was checked. A link that shows http, or whose text is not
 * its address, keeps the address it was written with.
 */
function linkTarget(href: unknown, label: string): string | null {
  const url = safeHref(href);
  if (url === null || !/^www\./i.test(label)) return url;
  try {
    return new URL(url).href === new URL(`http://${label}`).href ? `https://${label}` : url;
  } catch {
    // The text isn't an address after all.
    return url;
  }
}

/** A link shows its text only and opens in a new tab. Any other link is its text, unlinked. */
function Link({ node, href, children }: ElementProps<'a'>) {
  const url = linkTarget(href, textOf(node));
  if (url === null) return <>{children}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Inert links, for stopped drafts and, until the kernel's reply check reads Markdown links,
 * ClaudeMessage's prose (its `PROSE_LINKS`). `linksAsText` has already turned every link into its
 * words and its address as written, so no link reaches the page. Should one ever arrive, it is its
 * words, unlinked.
 */
function Unlinked({ children }: ElementProps<'a'>) {
  return <>{children}</>;
}

/**
 * A header cell. An empty one, such as a table's top-left corner, names no column, so it is a
 * plain cell that screen readers skip, drawn as the header row.
 */
function HeaderCell({ node, ...props }: ElementProps<'th'>) {
  if (textOf(node).trim() === '') return <td {...(props as ElementProps<'td'>)} />;
  return <th {...props} />;
}

/** Never an image: hardening has already turned each into its alt text, and this keeps it so. */
function Image({ alt }: ElementProps<'img'>) {
  return alt ?? null;
}

const BLOCKS: Components = {
  p: plain('p'),
  h1: plain('h1'),
  h2: plain('h2'),
  h3: plain('h3'),
  h4: plain('h4'),
  h5: plain('h5'),
  h6: plain('h6'),
  strong: plain('strong'),
  ul: plain('ul'),
  ol: plain('ol'),
  li: plain('li'),
  blockquote: plain('blockquote'),
  hr: plain('hr'),
  code: plain('code'),
  pre: plain('pre'),
  img: Image,
  table: Table,
  thead: plain('thead'),
  tbody: plain('tbody'),
  tr: plain('tr'),
  th: HeaderCell,
  td: plain('td'),
};

/** Each `links` setting's elements, made once so Streamdown keeps its rendered blocks between renders. */
const COMPONENTS: Record<NonNullable<ChatMarkdownProps['links']>, Components> = {
  open: { ...BLOCKS, a: Link },
  inert: { ...BLOCKS, a: Unlinked },
};

/**
 * How Streamdown closes unfinished Markdown in text that is still arriving: a link shows its text
 * until its address is whole, and nothing adds math markers, since math isn't rendered.
 */
const CLOSE_UNFINISHED: StreamdownProps['remend'] = { linkMode: 'text-only', katex: false };

/**
 * Streamdown's word animation, which wraps each word that is new since the last render in a span
 * (`data-sd-animate`). ChatMarkdown.css settles those spans in on `motion-settle`; it ignores the
 * timings Streamdown writes on each span, because Streamdown cuts a word's settle short when the
 * next word arrives, and at the reveal's pace that is every few frames.
 */
const SETTLE: StreamdownProps['animated'] = { sep: 'word', stagger: 0 };

/** Calls `onRevealed` once, the first time `whole` is true, before the browser draws that moment. */
function useRevealedOnce(whole: boolean, onRevealed: (() => void) | undefined): void {
  const onRevealedRef = useRef(onRevealed);
  const toldRef = useRef(false);
  useLayoutEffect(() => {
    onRevealedRef.current = onRevealed;
  });
  useLayoutEffect(() => {
    if (!whole || toldRef.current) return;
    toldRef.current = true;
    onRevealedRef.current?.();
  }, [whole]);
}

/**
 * Claude's reply as Markdown, rendered with Streamdown under the safety settings: no images, no raw
 * HTML, links only to http, https and mailto. A growing text shows up to its last whole word, with
 * unfinished Markdown closed; a revealed one shows a growing start of itself, word by word.
 */
export function ChatMarkdown({ text, streaming = false, reveal = false, revealLength, onRevealed, links = 'inert' }: ChatMarkdownProps) {
  const reduced = useReducedMotion();
  const { shown, whole } = useReveal(text, streaming, reveal && !reduced, revealLength);
  useRevealedOnce(whole, onRevealed);
  return (
    <Streamdown
      // Streamdown redraws only when its text or animation changes, so a change of links draws anew.
      key={links}
      className="cd-md cd-type-reply"
      components={COMPONENTS[links]}
      remarkPlugins={REMARK_PLUGINS[links]}
      parseMarkdownIntoBlocksFn={blocksOf}
      remarkRehypeOptions={TO_HTML}
      rehypePlugins={REHYPE_PLUGINS}
      parseIncompleteMarkdown={streaming || !whole}
      remend={CLOSE_UNFINISHED}
      animated={SETTLE}
      // On for as long as the text streams or is revealed, so its last words settle all the way.
      isAnimating={!reduced && (streaming || reveal)}
    >
      {text.slice(0, shown)}
    </Streamdown>
  );
}
