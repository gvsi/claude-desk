import { useRef } from 'react';

import type { CardBlock, RenderedBlock } from '../../../api/contracts.ts';
import { ChatMarkdown } from '../ChatMarkdown/ChatMarkdown.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { useMessageReveal } from './useMessageReveal.ts';

import './ClaudeMessage.css';

/**
 * How links in Claude's prose show. The kernel's reply check doesn't read Markdown link targets
 * yet, so a link that showed only its text could hide a target nothing checked: each shows its
 * text, then its address, and opens nothing. This flips to 'open' once the kernel's Markdown link
 * check is on main.
 */
const PROSE_LINKS = 'inert' as const;

export interface ClaudeMessageProps {
  /** The delivered message's blocks (`EvMessage.blocks`), in order, exactly as they arrived. */
  blocks: readonly RenderedBlock[];
  /** The event's `language`: it picks the card chrome and sets `lang` on the message. */
  language: CopyLanguage;
  /** The owner's display name (`owner_display_name`), for the "{owner} said" card label. */
  ownerName: string;
  /** Vision pages only: each document card's Download goes nowhere (`ReplyCard`'s `inertDownload`). */
  inertDownload?: boolean;
  /** Vision pages only: each prose block as written, one plain paragraph, never Markdown. */
  plainProse?: boolean;
  /**
   * The message arrived live, on a page already open: its words are revealed word by word, then its
   * cards fade and rise in, one by one, and what its `TranscriptRow` attaches follows them. Read
   * once, when first drawn. Never for a message from history. Under reduced motion it shows whole.
   */
  reveal?: boolean;
}

/** A prose block with words in it: a blank one has nothing to say, so it takes no space. */
const hasWords = (block: RenderedBlock) => block.kind === 'prose' && block.text.trim() !== '';

/**
 * A message from Claude, or from the Desk itself (author `desk`): each prose block as Markdown in
 * the serif reply type, each card block as a typed reply card, in order. No bubble, no avatar and
 * nothing else: the delivered blocks are the whole message.
 */
export function ClaudeMessage({ blocks, language, ownerName, inertDownload = false, plainProse = false, reveal = false }: ClaudeMessageProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Each prose block's place among the prose blocks, by its index in `blocks`.
  const prose = blocks.flatMap((block, index) => (hasWords(block) ? [index] : []));
  const shown = useMessageReveal(ref, prose.length, blocks.filter((block) => block.kind !== 'prose').length, reveal);
  return (
    <div ref={ref} className={`cd-claude-message${shown.root.className}`} lang={language} aria-busy={shown.root['aria-busy']} style={shown.root.style}>
      {blocks.map((block, index) => {
        if (block.kind === 'prose') {
          // A blank prose block has nothing to say, so it takes no space; a revealed one waits for the words before it.
          const nth = prose.indexOf(index);
          if (nth === -1 || nth >= shown.drawn) return null;
          if (plainProse) {
            return (
              <p key={index} className="cd-claude-message__prose cd-claude-message__prose--plain cd-type-reply">
                {block.text}
              </p>
            );
          }
          return (
            <div key={index} className="cd-claude-message__prose cd-type-reply">
              <ChatMarkdown
                text={block.text}
                links={PROSE_LINKS}
                reveal={shown.revealing}
                onRevealed={shown.revealing ? () => shown.revealed(nth) : undefined}
              />
            </div>
          );
        }
        // Anything else is a card. A template this build doesn't know shows its text in a
        // plain card, as ReplyCard does for any unknown template.
        return <ReplyCard key={index} block={block as CardBlock} language={language} ownerName={ownerName} inertDownload={inertDownload} />;
      })}
    </div>
  );
}
