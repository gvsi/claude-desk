/**
 * Claude's reply while it is still being written in an owner chat (the setup consultant and Ask
 * Claude): the one place a growing reply is drawn. It takes the Markdown renderer's props (`text`,
 * the whole reply so far, and `streaming`), so the design system's renderer takes its place here,
 * and only here, once it lands. Until then it shows the text as plain paragraphs in the reply's
 * own type, split where the text leaves a blank line, as a saved setup reply is.
 */

export interface GrowingReplyProps {
  /** The whole reply so far. It may grow between renders and stop mid-word. */
  text: string;
  /** Still growing. */
  streaming?: boolean;
}

export function GrowingReply({ text }: GrowingReplyProps) {
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="cd-claude-message__prose cd-type-reply">
          {paragraph}
        </p>
      ))}
    </>
  );
}
