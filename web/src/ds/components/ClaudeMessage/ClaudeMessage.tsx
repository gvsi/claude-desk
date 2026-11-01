import type { CardBlock, RenderedBlock } from '../../../api/contracts.ts';
import { ChatMarkdown } from '../ChatMarkdown/ChatMarkdown.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';

import './ClaudeMessage.css';

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
}

/**
 * A message from Claude, or from the Desk itself (author `desk`): each prose block as Markdown in
 * the serif reply type, each card block as a typed reply card, in order. No bubble, no avatar and
 * nothing else: the delivered blocks are the whole message.
 */
export function ClaudeMessage({ blocks, language, ownerName, inertDownload = false, plainProse = false }: ClaudeMessageProps) {
  return (
    <div className="cd-claude-message" lang={language}>
      {blocks.map((block, index) => {
        if (block.kind === 'prose') {
          // A blank prose block has nothing to say, so it takes no space.
          if (block.text.trim() === '') return null;
          if (plainProse) {
            return (
              <p key={index} className="cd-claude-message__prose cd-claude-message__prose--plain cd-type-reply">
                {block.text}
              </p>
            );
          }
          return (
            <div key={index} className="cd-claude-message__prose cd-type-reply">
              <ChatMarkdown text={block.text} />
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
