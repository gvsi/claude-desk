/** Expectations read from the document, independent of whether its measurements have been filled. */
import type { Block, Inline } from '../about/documents.ts';

export function placeholderTexts(blocks: Block[]): string[] {
  const walk = (inlines: Inline[]): string[] => inlines.flatMap((inline) =>
    inline.kind === 'placeholder' ? [inline.text] : 'children' in inline ? walk(inline.children) : []);
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case 'paragraph':
        return walk(block.children);
      case 'list':
        return block.items.flatMap(walk);
      case 'table':
        return [...block.head, ...block.rows.flat()].flatMap(walk);
      default:
        return [];
    }
  });
}
