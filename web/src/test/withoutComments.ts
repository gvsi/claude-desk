/**
 * Source text without its comments, for the guards that read code and stylesheets: the design
 * system's and the app's read code the same way.
 */
import ts from 'typescript';

/** What `withoutComments` made of each source it read, by grammar and text: several guards read the same files. */
const COMMENT_FREE = new Map<string, string>();
/**
 * For a guard that reads every web source without its comments: parsing them all takes a few
 * seconds, more on a CI runner, once for whichever such guard runs first (`COMMENT_FREE`).
 */
export const READS_EVERY_SOURCE = { timeout: 30_000 };

/** `text` with each of `ranges` (start and end offsets) blanked: spaces, its line breaks kept. */
export function blanked(text: string, ranges: Iterable<readonly [number, number]>): string {
  const units = text.split('');
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i += 1) if (units[i] !== '\n' && units[i] !== '\r') units[i] = ' ';
  }
  return units.join('');
}

/**
 * `code` without its comments, so a guard reads only code and the strings code holds. TypeScript's
 * own parser finds them, so a comment marker in a string, a template literal, a regex or JSX text is
 * text, and a JSX expression holding only a comment is a comment. Each comment becomes spaces with its
 * line breaks kept, so the code keeps its place. `file` picks the grammar: TypeScript for a `.ts`
 * file, where `<T>(value: T) => value` is a generic, and TSX for anything else.
 */
export function withoutComments(code: string, file = 'code.tsx'): string {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const key = `${kind}\0${code}`;
  const known = COMMENT_FREE.get(key);
  if (known !== undefined) return known;
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const comments = new Map<number, number>();
  const jsxText: [number, number][] = [];
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) comments.set(range.pos, range.end);
  };
  // Every node and token, and the comments before and after each. JSX text is text, not trivia, and a
  // JSDoc comment is found as the comment before its node.
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    add(ts.getLeadingCommentRanges(code, node.getFullStart()));
    add(ts.getTrailingCommentRanges(code, node.end));
    for (const child of node.getChildren(tree)) if (!ts.isJSDoc(child)) visit(child);
  };
  visit(tree);
  const inText = (start: number) => jsxText.some(([from, to]) => from <= start && start < to);
  const stripped = blanked(code, [...comments].filter(([start]) => !inText(start)));
  COMMENT_FREE.set(key, stripped);
  return stripped;
}

/**
 * `css` without its comments, blanked as `withoutComments` blanks them. CSS has block comments only,
 * so a "//" in a URL is text, and a comment marker inside a quoted string is text too.
 */
export function withoutCssComments(css: string): string {
  const comments: [number, number][] = [];
  let quote = '';
  for (let i = 0; i < css.length; i += 1) {
    const char = css.charAt(i);
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote || char === '\n') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (css.startsWith('/*', i)) {
      const close = css.indexOf('*/', i + 2);
      const end = close === -1 ? css.length : close + 2;
      comments.push([i, end]);
      i = end - 1;
    }
  }
  return blanked(css, comments);
}
