/**
 * Claude's reply while it is still being written in an owner chat (the setup consultant and Ask
 * Claude): the one place a growing reply is drawn. It takes the Markdown renderer's props (`text`,
 * the whole reply so far, and `streaming`), so the design system's renderer takes its place here,
 * and only here, once it lands. Until then it shows the text as plain paragraphs in the reply's
 * own type, split where the text leaves a blank line, as a saved setup reply is. As the renderer
 * does, while `streaming` a last word shows only once more text follows it, so a word cut off
 * mid-delta never shows half-written.
 */

export interface GrowingReplyProps {
  /** The whole reply so far. It may grow between renders and stop mid-word. */
  text: string;
  /** Still growing: the last word waits for what follows it. */
  streaming?: boolean;
}

/** What a reply still being written shows: all but a last word that nothing follows yet. */
export function settledWords(text: string): string {
  if (/\s$/.test(text)) return text.trimEnd();
  const last = text.search(/\S+$/);
  return last <= 0 ? '' : text.slice(0, last).trimEnd();
}

export function GrowingReply({ text, streaming = false }: GrowingReplyProps) {
  const shown = streaming ? settledWords(text) : text;
  const paragraphs = shown.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '');
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
