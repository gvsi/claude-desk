import { Icon } from '../../icons/index.tsx';

import './ToolLabel.css';

export interface ToolLabelProps {
  /** What Claude did, in the API's words: "Searched your sample Claude memory". Shown as text, never markup. */
  text: string;
}

/**
 * A quiet inline line for something Claude did with a tool during setup, between its questions: a
 * 14 px icon and the words, in secondary meta type. It is a line to read, with nothing to press.
 */
export function ToolLabel({ text }: ToolLabelProps) {
  return (
    <p className="cd-tool-label cd-type-meta">
      <Icon name="document" size={14} className="cd-tool-label__icon" />
      <span className="cd-tool-label__text">{text}</span>
    </p>
  );
}
