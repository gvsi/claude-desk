/**
 * The copy check. Every story runs it on its canvas after it renders (the project-level
 * `afterEach` in `.storybook/preview.tsx`), and screen tests run it on what they render.
 *
 * It reads what a person sees or hears: visible text plus the attributes a screen reader or a
 * tooltip reads. Subtrees marked `aria-hidden="true"` are skipped, so an initials monogram beside
 * the name written out passes. Text a person wrote (a visitor's message, an owner's whisper)
 * carries `data-copy="user"`; the voice rules (all caps, exclamation marks) don't apply to it, the
 * design rules (arrows, uppercase styling) still do. The one all-caps label is the lockup's "Preview"
 * badge (`CAPS_BADGE`). Machine text shown as written (an address, a
 * request, a key) carries `data-copy="code"` and is read the same way.
 */

/** The footer on every surface, word for word (`[data-ds="concept-footer"]`). */
export const CONCEPT_FOOTER_TEXT = 'Concept prototype by Giovanni Alcantara, not an Anthropic product';

/** Unicode arrows (Arrows, Supplemental Arrows A, B and C, dingbat and miscellaneous arrows). */
export const ARROW_CHARACTERS = /[\u2190-\u21FF\u27F0-\u27FF\u2794-\u27BF\u2900-\u297F\u2B00-\u2B11\u2B60-\u2BFF\u{1F800}-\u{1F8FF}]/u;

/** Rendered copy also may not draw an arrow out of ASCII. */
const ARROW = new RegExp(`${ARROW_CHARACTERS.source}|->`, 'u');

/**
 * Words written in capitals that stay in capitals, among them the agents page's "RFC 8785 JSON".
 * Plurals of these ("PDFs", "APIs") pass too, because only the run of two or more capitals is looked
 * up. "IA" is AI in Spanish, as the public page's disclosure says it ("una IA que responde por …").
 * "KB" is the unit of a file's size, as Settings › Knowledge writes it ("up to 100 KB").
 */
export const COPY_ACRONYMS: ReadonlySet<string> = new Set([
  'I',
  'AI',
  'IA',
  'PDF',
  'DOCX',
  'QR',
  'CPA',
  'ZIP',
  'SMS',
  'USD',
  'API',
  'CEO',
  'CI',
  'MCP',
  'URL',
  'US',
  'RFC',
  'JSON',
  'KB',
]);

/**
 * Names whose capitals sit beside a digit or lower case, allowed only as the whole word: "AP2" and
 * "SymCC" pass, while the runs inside them ("AP", "CC") still fail on their own or in another word.
 */
export const COPY_WHOLE_WORDS: ReadonlySet<string> = new Set(['AP2', 'SymCC']);

/** A word: letters, marks and digits, so "AP2" is one word and "AP2’s" is "AP2" then "s". */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** Two or more capitals in a row: "SEND", the "DONALD" in "McDONALD", the "PDF" in "PDFs". */
const CAPS_RUN = /\p{Lu}{2,}/gu;

/** The runs of capitals in `text` that no allowlist covers, each once, in the order they appear. */
function shoutedRuns(text: string): string[] {
  const words = (text.match(WORD) ?? []).filter((word) => !COPY_WHOLE_WORDS.has(word));
  const runs = words.flatMap((word) => word.match(CAPS_RUN) ?? []);
  return [...new Set(runs)].filter((run) => !COPY_ACRONYMS.has(run));
}

/** Exclamation marks, Spanish opening marks and the emoji forms. NFKC folds the fullwidth one. */
const EXCLAMATION = /[!\u00A1\u2755\u2757]/u;

/** Attributes whose text is read aloud, shown as a tooltip or shown as a label. */
const READ_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt', 'label'];

/** An `<input>` of these types shows its `value` as its label. */
const LABELLED_BY_VALUE = new Set(['button', 'submit', 'reset']);

/** Elements whose text is never shown, by `localName` (lower case in HTML and in SVG alike). */
const UNSHOWN = new Set(['script', 'style', 'template', 'noscript']);

interface Context {
  problems: string[];
  /** Inside `[data-copy="user"]` or `[data-copy="code"]`: someone's own words or machine text, exempt from the voice rules. */
  user: boolean;
}

function sample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function checkText(raw: string, source: string, ctx: Context): void {
  const text = raw.normalize('NFKC');
  if (ARROW.test(text)) ctx.problems.push(`arrow in ${source}: "${sample(raw)}"`);
  if (ctx.user) return;
  const caps = shoutedRuns(text);
  if (caps.length > 0) {
    ctx.problems.push(`all caps ${caps.map((run) => `"${run}"`).join(', ')} in ${source}: "${sample(raw)}"`);
  }
  if (EXCLAMATION.test(text)) ctx.problems.push(`exclamation mark in ${source}: "${sample(raw)}"`);
}

/** The label of an `<input type="button|submit|reset">`, or null for any other element. */
function valueLabel(el: Element): string | null {
  return el.localName === 'input' && LABELLED_BY_VALUE.has((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : null;
}

/** True when `el` itself draws text: its own text nodes, a placeholder or a value shown as a label. */
function drawsText(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === child.TEXT_NODE && (child.textContent ?? '').trim() !== '') return true;
  }
  return el.hasAttribute('placeholder') || valueLabel(el) !== null;
}

/**
 * The product's one all-caps label (owner, 2026-10-30): the lockup's badge, `Pill caps`, whose word is
 * written "Preview" and drawn in capitals. Only that element, with exactly that word, may be uppercased.
 */
export const CAPS_BADGE = { selector: '[data-ds="preview-badge"]', text: 'Preview' } as const;

function isTheCapsBadge(el: Element): boolean {
  return el.matches(CAPS_BADGE.selector) && el.children.length === 0 && el.textContent === CAPS_BADGE.text;
}

/** Capitals drawn by CSS: uppercase or title case transforms and small caps. */
function checkStyle(el: Element, ctx: Context): void {
  const view = el.ownerDocument.defaultView;
  if (!view || !drawsText(el)) return;
  const style = view.getComputedStyle(el);
  const tag = el.localName;
  const text = sample(el.textContent || el.getAttribute('placeholder') || valueLabel(el) || '');
  const transform = /\b(?:uppercase|capitalize)\b/.exec(style.textTransform)?.[0];
  if (transform && !(transform === 'uppercase' && isTheCapsBadge(el))) {
    ctx.problems.push(`text-transform ${transform} on <${tag}>: "${text}"`);
  }
  const caps = style.fontVariantCaps;
  if (caps && caps !== 'normal') ctx.problems.push(`font-variant-caps ${caps} on <${tag}>: "${text}"`);
}

function visit(el: Element, parent: Context): void {
  if (el.getAttribute('aria-hidden') === 'true' || UNSHOWN.has(el.localName)) return;
  const marked = el.getAttribute('data-copy');
  const ctx: Context = { problems: parent.problems, user: parent.user || marked === 'user' || marked === 'code' };

  for (const name of READ_ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value) checkText(value, name, ctx);
  }
  const label = valueLabel(el);
  if (label) checkText(label, 'value', ctx);
  checkStyle(el, ctx);

  for (const child of el.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text.trim() !== '') checkText(text, 'text', ctx);
    } else if (child.nodeType === child.ELEMENT_NODE) {
      visit(child as Element, ctx);
    }
  }
}

function rawText(el: Element): string {
  if (el.getAttribute('aria-hidden') === 'true' || UNSHOWN.has(el.localName)) return '';
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === child.TEXT_NODE) text += child.textContent ?? '';
    else if (child.nodeType === child.ELEMENT_NODE) text += rawText(child as Element);
  }
  return text;
}

/** What a person reads in `el`: text outside aria-hidden subtrees, whitespace collapsed. */
function readText(el: Element): string {
  return rawText(el).replace(/\s+/g, ' ').trim();
}

function checkConceptFooters(root: HTMLElement, ctx: Context): void {
  const footers = [...(root.matches('[data-ds="concept-footer"]') ? [root] : []), ...root.querySelectorAll('[data-ds="concept-footer"]')];
  for (const footer of footers) {
    const text = readText(footer);
    if (text !== CONCEPT_FOOTER_TEXT) ctx.problems.push(`concept footer reads "${text}" instead of "${CONCEPT_FOOTER_TEXT}"`);
  }
}

/**
 * Throws one `Error` listing every copy problem under `root`, each with the text it was found in.
 */
export function assertCleanCopy(root: HTMLElement): void {
  const ctx: Context = { problems: [], user: root.parentElement?.closest('[data-copy="user"], [data-copy="code"]') != null };
  visit(root, ctx);
  checkConceptFooters(root, ctx);
  if (ctx.problems.length > 0) {
    const count = ctx.problems.length === 1 ? '1 problem' : `${ctx.problems.length} problems`;
    throw new Error(`Copy check found ${count}:\n${ctx.problems.map((p) => `- ${p}`).join('\n')}`);
  }
}
