import { Icon } from '../../icons/index.tsx';

import './Whisper.css';

export interface WhisperProps {
  /** Who and when, in the consumer's words: "Your whisper, 12:08. Only Claude sees this." */
  caption: string;
  /** The owner's whisper, exactly as written. */
  text: string;
}

/**
 * An owner's whisper in their transcript: a caption with the struck-out eye (only Claude sees it),
 * then the words in a dashed bubble. The visitor never sees a whisper.
 */
export function Whisper({ caption, text }: WhisperProps) {
  return (
    <div className="cd-whisper">
      <p className="cd-whisper__caption cd-type-caption">
        <Icon name="whisper" size={14} />
        <span>{caption}</span>
      </p>
      <p className="cd-whisper__bubble cd-type-body" data-copy="user">
        {text}
      </p>
    </div>
  );
}
