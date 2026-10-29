/**
 * What a reply card shows, read from the kernel's rendered block and nothing else. Every string is
 * the kernel's own; this only picks fields, drops empty ones and refuses any link that isn't one of
 * the API's proxied paths.
 */
import type { CardBlock, CardOption, ClauseTemplate } from '../../../api/contracts.ts';

export interface CardView {
  /** The block's `title`, or null when it has none. */
  headline: string | null;
  /** The block's non-empty `lines`, in order; its `text`, line by line, when it carries no card data. */
  details: string[];
  /** The block's `options`, in order. */
  options: CardOption[];
  /** The block's `href` when it is its template's proxied path; otherwise null, and the card has no link. */
  href: string | null;
}

/**
 * The only links a card may carry, by template: the mock checkout and the document download, each a
 * same-origin path with one opaque token. Anything else (another template, a scheme, another host, a
 * query, a fragment, dots or another path) is no link at all.
 */
const LINK_PATHS: Partial<Readonly<Record<ClauseTemplate, RegExp>>> = {
  payment_link: /^\/pay\/[A-Za-z0-9_-]+$/,
  document_link: /^\/api\/d\/[A-Za-z0-9_-]+$/,
};

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function safeHref(block: CardBlock): string | null {
  const path = Object.hasOwn(LINK_PATHS, block.template) ? LINK_PATHS[block.template] : undefined;
  return path !== undefined && typeof block.href === 'string' && path.test(block.href) ? block.href : null;
}

export function cardView(block: CardBlock): CardView {
  const href = safeHref(block);
  const headline = filled(block.title) ? block.title : null;
  const lines = Array.isArray(block.lines) ? block.lines.filter(filled) : [];
  const options = Array.isArray(block.options) ? block.options : [];
  if (headline === null && lines.length === 0 && options.length === 0) {
    const text = typeof block.text === 'string' ? block.text : '';
    return { headline: null, details: text.split(/\r?\n/).filter(filled), options: [], href };
  }
  return { headline, details: lines, options, href };
}
