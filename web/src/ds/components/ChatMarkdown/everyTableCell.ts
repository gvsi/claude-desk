/** The part of a Markdown syntax tree node this step reads and writes. */
interface MarkdownNode {
  type: string;
  align?: (string | null)[] | null;
  children?: MarkdownNode[];
}

function widen(node: MarkdownNode): void {
  for (const child of node.children ?? []) widen(child);
  if (node.type !== 'table' || node.children === undefined) return;
  const [header] = node.children;
  const width = Math.max(...node.children.map((row) => row.children?.length ?? 0));
  if (header?.children === undefined || header.children.length >= width) return;
  const added = width - header.children.length;
  header.children = [...header.children, ...Array.from({ length: added }, () => ({ type: 'tableCell', children: [] }))];
  node.align = [...(node.align ?? []), ...Array.from({ length: width - (node.align?.length ?? 0) }, () => null)];
}

/**
 * GitHub Markdown gives a table as many columns as its header row and drops any cell past them,
 * so a row wider than its header would lose words. This remark step, run before the table becomes
 * HTML, widens the header to the widest row with empty cells, so every cell shows. An empty header
 * cell renders as a plain cell, as a table's empty corner does.
 */
export function everyTableCell() {
  return (tree: MarkdownNode): void => widen(tree);
}
