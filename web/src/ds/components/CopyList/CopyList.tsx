import { useRef, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { copyResultLine, useCopyText } from '../CopyField/useCopyText.ts';
import { CopyResult } from '../CopyResult/CopyResult.tsx';

import './CopyList.css';

export interface CopyListItem {
  /** Where the words go: "Google profile", "Email signature", "Voicemail". */
  title: string;
  /**
   * The words. A string is shown and copied as it is. A node, when they hold a name someone chose
   * (the business's, the owner's), lets the screen mark each name as user text and isolate it:
   * `<bdi data-copy="user">`. Copy then copies what is shown, as plain text: a line break for each
   * `<br>`, and no words only a screen reader hears (`.cd-sr-only`).
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

/** Spaces as HTML collapses them; a non-breaking space stays. */
const COLLAPSIBLE = /[ \t\n\r\f]+/g;

/**
 * The words as they are shown, read from the rendered words without changing them: text with its
 * spaces collapsed as the browser draws them, a line break for each `<br>`, and nothing from an
 * element nobody sees: one that is `.cd-sr-only` (words for a screen reader alone, which the
 * browser's own `innerText` would keep, since clipped text is still rendered) or not displayed.
 * The words are a paragraph's inline content, so this is what a person reads.
 */
function shownText(el: Element): string {
  const view = el.ownerDocument.defaultView;
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      text += (child.textContent ?? '').replace(COLLAPSIBLE, ' ');
    } else if (child instanceof Element) {
      if (child.localName === 'br') text += '\n';
      else if (child.classList.contains('cd-sr-only') || view?.getComputedStyle(child).display === 'none') continue;
      else text += shownText(child);
    }
  }
  return text;
}

/**
 * The words to copy: the screen's string as it is, or, for words with marked names in them, the
 * words as they are shown (`shownText`), with no spaces at the ends of a line.
 */
function plainWords(text: ReactNode, shown: HTMLElement | null): string {
  if (typeof text === 'string') return text;
  if (!shown) return '';
  return shownText(shown)
    .replace(/ {2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^ +| +$/g, '');
}

function CopyRow({ item, onCopy }: { item: CopyListItem; onCopy: CopyListProps['onCopy'] }) {
  const words = useRef<HTMLParagraphElement>(null);
  const { state, announcement, copy } = useCopyText(onCopy);
  const result = copyResultLine(state);
  return (
    <li className="cd-copy-list__row">
      <div className="cd-copy-list__text">
        <p className="cd-copy-list__title cd-type-control">{item.title}</p>
        <p ref={words} className="cd-copy-list__words cd-type-meta">
          {item.text}
        </p>
        <CopyResult result={result} announcement={announcement} className="cd-copy-list__result cd-type-meta" />
      </div>
      <span className="cd-copy-list__copy">
        <Button variant="secondary" onClick={() => void copy(plainWords(item.text, words.current), words.current)}>
          Copy<span className="cd-sr-only"> {item.title}</span>
        </Button>
      </span>
    </li>
  );
}
