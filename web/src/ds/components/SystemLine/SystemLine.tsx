import './SystemLine.css';

export interface SystemLineProps {
  /** What happened, in the consumer's words: "Mike Turner joined the chat", "Claude is helping again." */
  text: string;
  /** Initials beside the words, for a person joining; hidden from screen readers. */
  initials?: string;
}

/**
 * A line in the chat about the chat itself, centered between hairlines: someone joined, Claude is
 * back, a visitor confirmed it's them. It is a status, so a screen reader announces it, and it
 * shows no time.
 */
export function SystemLine({ text, initials }: SystemLineProps) {
  const hasInitials = initials !== undefined && initials.trim() !== '';
  return (
    <p className="cd-system-line cd-type-caption" role="status">
      <span className="cd-system-line__rule" aria-hidden="true" />
      {hasInitials ? (
        <span className="cd-system-line__initials" aria-hidden="true">
          {initials}
        </span>
      ) : null}
      <span className="cd-system-line__text">{text}</span>
      <span className="cd-system-line__rule" aria-hidden="true" />
    </p>
  );
}
