import { Icon } from '../../icons/index.tsx';

import './VisitorMessage.css';

export interface VisitorMessageProps {
  /** What the visitor typed, exactly as they typed it. */
  text: string;
  /** Claude's translation for the owner, when the visitor wrote in another language. */
  translation?: string;
}

/**
 * A visitor's message: their words in a faint bubble on the right. With a translation, a line
 * under it says "Translated by Claude:" before the translated words.
 */
export function VisitorMessage({ text, translation }: VisitorMessageProps) {
  const translated = translation !== undefined && translation.trim() !== '';
  return (
    <div className="cd-visitor-message">
      <p className="cd-visitor-message__bubble cd-type-message" data-copy="user">
        {text}
      </p>
      {translated ? (
        <p className="cd-visitor-message__translation cd-type-meta">
          <Icon name="translate" size={14} />
          <span>
            Translated by Claude: <span data-copy="user">{translation}</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}
