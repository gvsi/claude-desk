/**
 * Claude's reply while it is still being written in an owner chat (the setup consultant and Ask
 * Claude): the one place a growing reply is drawn. It is the design system's Markdown renderer, in
 * the frame a saved reply's prose has (`ClaudeMessage`) and with its links shown the same way
 * (`PROSE_LINKS`), so the saved reply takes its place without a jump. While `streaming`, the
 * renderer shows the text up to its last whole word, with unfinished Markdown closed, and settles
 * new words in, or shows them at once under reduced motion.
 */
import { ChatMarkdown, PROSE_LINKS } from '../ds/index.ts';

export interface GrowingReplyProps {
  /** The whole reply so far. It may grow between renders and stop mid-word. */
  text: string;
  /** Still growing: the last word waits for what follows it. */
  streaming?: boolean;
}

/**
 * Whether a reply still being written has anything to show yet: all but a last word that nothing
 * follows. The screens show Claude's writing dots until it has.
 */
export function settledWords(text: string): string {
  if (/\s$/.test(text)) return text.trimEnd();
  const last = text.search(/\S+$/);
  return last <= 0 ? '' : text.slice(0, last).trimEnd();
}

export function GrowingReply({ text, streaming = false }: GrowingReplyProps) {
  return (
    <div className="cd-claude-message__prose cd-type-reply">
      <ChatMarkdown text={text} streaming={streaming} links={PROSE_LINKS} />
    </div>
  );
}
