import './CodeBlock.css';

export interface CodeBlockProps {
  /** The code, exactly as a developer would type or copy it: lines separated by `\n`. */
  code: string;
}

/**
 * Code shown as written, such as an example request on the agents page: mono type in a quiet box,
 * every line kept, long lines wrapping inside the box rather than scrolling the page. Marked as
 * machine text (`data-copy="code"`), so the copy check reads it as it is, and `translate="no"`, so a
 * page translator leaves it as it is too.
 */
export function CodeBlock({ code }: CodeBlockProps) {
  return (
    <pre className="cd-code-block cd-type-code" data-copy="code" translate="no">
      <code>{code}</code>
    </pre>
  );
}
