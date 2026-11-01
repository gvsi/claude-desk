/** The part of a Markdown syntax tree node this step reads and writes. */
interface MarkdownNode {
  type: string;
  checked?: boolean | null;
  value?: string;
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
}

/** A task item's mark, `[ ]`, `[x]` or `[X]`. */
const MARK = /\[[ xX]\]/;

/** The item's mark as written, read from the source where it can be, else as GitHub writes it. */
function markOf(item: MarkdownNode, source: string): string {
  const start = item.position?.start.offset;
  const written = start === undefined ? null : MARK.exec(source.slice(start, start + 16));
  return written?.[0] ?? (item.checked === true ? '[x]' : '[ ]');
}

function restore(node: MarkdownNode, source: string): void {
  for (const child of node.children ?? []) restore(child, source);
  if (node.type !== 'listItem' || typeof node.checked !== 'boolean') return;
  const mark = markOf(node, source);
  node.checked = null;
  const [first] = node.children ?? [];
  if (first?.type === 'paragraph') first.children = [{ type: 'text', value: `${mark} ` }, ...(first.children ?? [])];
  else node.children = [{ type: 'paragraph', children: [{ type: 'text', value: mark }] }, ...(node.children ?? [])];
}

/**
 * GitHub Markdown turns a list item that starts with `[ ]` or `[x]` into a checkbox and drops the
 * mark. A chat reply draws no controls, so this remark step turns each task item back into its
 * words as written, its mark included, and no checkbox is drawn.
 */
export function taskItemsAsText() {
  return (tree: MarkdownNode, file: { value?: unknown }): void => restore(tree, String(file.value ?? ''));
}
