/** The part of a Markdown syntax tree node this step reads and writes. */
interface MarkdownNode {
  type: string;
  label?: string | null;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
}

/** A footnote's marker as it was written: `[^note]`. */
function marker(node: MarkdownNode): string {
  return `[^${node.label ?? node.identifier ?? ''}]`;
}

/** The note's own blocks, led by its marker and colon as written, where the note stood. */
function definitionAsText(definition: MarkdownNode): MarkdownNode[] {
  const [first, ...rest] = definition.children ?? [];
  if (first?.type === 'paragraph') {
    return [{ ...first, children: [{ type: 'text', value: `${marker(definition)}: ` }, ...(first.children ?? [])] }, ...rest];
  }
  return [{ type: 'paragraph', children: [{ type: 'text', value: `${marker(definition)}:` }] }, ...(definition.children ?? [])];
}

function restore(node: MarkdownNode): void {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child) => {
    restore(child);
    if (child.type === 'footnoteReference') return [{ type: 'text', value: marker(child) }];
    if (child.type === 'footnoteDefinition') return definitionAsText(child);
    return [child];
  });
}

/**
 * Footnotes aren't a chat format. GitHub Markdown would move each note to the end of the reply,
 * under a "Footnotes" label with a back link, adding words and changing their order. This remark
 * step, run after GitHub Markdown's, turns each footnote back into the words as written, in place:
 * `[^note]` where it was called, and `[^note]: ` before the note where it was defined.
 */
export function footnotesAsText() {
  return (tree: MarkdownNode): void => restore(tree);
}
