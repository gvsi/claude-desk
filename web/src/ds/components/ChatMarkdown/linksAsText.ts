/** The part of a Markdown syntax tree node this step reads and writes. */
interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
}

/** The words a node shows. */
function wordsOf(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return (node.children ?? []).map(wordsOf).join('');
}

/**
 * An address without its scheme or a trailing slash, to tell whether a link's text already is its
 * address: `https://example.com/`, `example.com` and a `www.example.com` linked to
 * `http://www.example.com` all match their text.
 */
function bare(address: string): string {
  return address
    .trim()
    .replace(/^(?:https?:\/\/|mailto:)/i, '')
    .replace(/\/$/, '');
}

/** A link's words, then its address as written, unless its words already are its address. */
function asText(link: MarkdownNode, url: string): MarkdownNode[] {
  const children = link.children ?? [];
  if (url.trim() === '' || bare(wordsOf(link)) === bare(url)) return children;
  return [...children, { type: 'text', value: ` (${url})` }];
}

function definitionsIn(node: MarkdownNode, found: Map<string, string>): Map<string, string> {
  if (node.type === 'definition' && node.identifier !== undefined) found.set(node.identifier, node.url ?? '');
  for (const child of node.children ?? []) definitionsIn(child, found);
  return found;
}

function restore(node: MarkdownNode, definitions: ReadonlyMap<string, string>): void {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child) => {
    restore(child, definitions);
    if (child.type === 'link') return asText(child, child.url ?? '');
    const defined = child.type === 'linkReference' && child.identifier !== undefined ? definitions.get(child.identifier) : undefined;
    return defined === undefined ? [child] : asText(child, defined);
  });
}

/**
 * For inert links: each link becomes its words, then its address in brackets exactly as Claude
 * wrote it, with nothing to click. The address is the one in the Markdown, not one a URL parser
 * has rewritten with an added slash, percent-encoding or an `xn--` domain, and a target that isn't
 * http, https or mailto shows too. A link whose words already are its address shows once.
 * Reference links take their address from their definition.
 */
export function linksAsText() {
  return (tree: MarkdownNode): void => restore(tree, definitionsIn(tree, new Map()));
}
