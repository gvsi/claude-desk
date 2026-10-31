import { useRef, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { copyResultLine, useCopyText } from '../CopyField/useCopyText.ts';

import './CopyList.css';

export interface CopyListItem {
  /** Where the words go: "Google profile", "Email signature", "Voicemail". */
  title: string;
  /**
   * The words, as they are shown and copied. A node when they hold a name someone chose (the
   * business's, the owner's), so the screen can mark each name as user text:
   * `<span data-copy="user">`. Copy then copies the words as they read, as plain text.
   */
  text: ReactNode;
}

export interface CopyListProps {
  /** The list's name: "Ready-made words". */
  label: string;
  items: readonly CopyListItem[];
  /** Copies one block's words. The screen owns the clipboard; a throw or a rejection means it couldn't. */
  onCopy: (text: string) => Promise<void> | void;
}

/**
 * Ready-made words an owner copies to put their Desk where customers look: one card, a row for
 * each block with its name, its words and Copy at its right, ruled between the rows. Each copy
 * goes through the screen; when one fails, that block's words are selected and its row says so.
 */
export function CopyList({ label, items, onCopy }: CopyListProps) {
  return (
    <ul role="list" className="cd-copy-list" aria-label={label}>
      {items.map((item) => (
        <CopyRow key={item.title} item={item} onCopy={onCopy} />
      ))}
    </ul>
  );
}

/** The words to copy: the screen's string as it is, or, for words with marked names in them, the text they read as. */
function plainWords(text: ReactNode, shown: HTMLElement | null): string {
  return typeof text === 'string' ? text : (shown?.textContent ?? '');
}

function CopyRow({ item, onCopy }: { item: CopyListItem; onCopy: CopyListProps['onCopy'] }) {
  const words = useRef<HTMLParagraphElement>(null);
  const { state, copy } = useCopyText(onCopy);
  return (
    <li className="cd-copy-list__row">
      <div className="cd-copy-list__text">
        <p className="cd-copy-list__title cd-type-control">{item.title}</p>
        <p ref={words} className="cd-copy-list__words cd-type-meta">
          {item.text}
        </p>
        <p role="status" className="cd-copy-list__result cd-type-meta">
          {copyResultLine(state)}
        </p>
      </div>
      <span className="cd-copy-list__copy">
        <Button variant="secondary" onClick={() => void copy(plainWords(item.text, words.current), words.current)}>
          Copy<span className="cd-sr-only"> {item.title}</span>
        </Button>
      </span>
    </li>
  );
}
