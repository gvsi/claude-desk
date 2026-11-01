import { useCallback, useContext, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

import { useReducedMotion } from '../ChatMarkdown/useReducedMotion.ts';
import { RowArrivalContext } from '../TranscriptRow/arrival.ts';

/** The motion a revealed message comes in with: each word settling in (ChatMarkdown.css), then its cards (ClaudeMessage.css). */
const COMING_IN: ReadonlySet<string> = new Set(['cd-md-settle', 'cd-md-settle-marker', 'cd-claude-message-follow']);

/** From the third card on, cards share a beat, so a long list never keeps what follows waiting. */
const CARD_BEATS = 3;

export interface MessageReveal {
  /** The message's words are being revealed, or are still settling in: `ChatMarkdown`'s `reveal`. */
  revealing: boolean;
  /** How many prose blocks to draw: those whose words are whole, and the one being revealed. */
  drawn: number;
  /** The prose block at `nth` (among the prose blocks) shows all its words. */
  revealed: (nth: number) => void;
  /** The message's own attributes while it comes in: its classes after `cd-claude-message`, `aria-busy` and style. */
  root: { className: string; 'aria-busy': true | undefined; style: CSSProperties | undefined };
}

/**
 * How a message from Claude comes in. Revealed (`reveal`, read once, when first drawn, and never
 * under reduced motion), its prose blocks show word by word, one after another, while its cards wait
 * unseen in their places. Once the words are whole, the cards fade and rise in, one by one,
 * `motion-follow` apart, the first a beat after the words, or at once with no words before them,
 * and the `TranscriptRow` it arrived in brings what is attached in after them. Once its words
 * have settled and its cards have come in, it is drawn as a message from history is. Not revealed,
 * it shows whole at once.
 */
export function useMessageReveal(ref: RefObject<HTMLElement | null>, prose: number, cards: number, reveal: boolean): MessageReveal {
  const reduced = useReducedMotion();
  const [revealing] = useState(reveal && !reduced);
  // How many prose blocks show all their words.
  const [whole, setWhole] = useState(revealing ? 0 : prose);
  const wordsIn = whole >= prose;
  // Whether everything in the message has come in: at once when it isn't revealed.
  const [settled, setSettled] = useState(!revealing);
  const row = useContext(RowArrivalContext);
  // The first card's beat: one after the words, or at once with none.
  const from = prose > 0 ? 1 : 0;

  // Before the first paint, while the words come in, the row's attached lines wait for them.
  const [waits] = useState(revealing && !wordsIn);
  useLayoutEffect(() => {
    if (waits) row?.wait();
  }, [waits, row]);

  // Once the words are whole, the row's lines follow from the beat after the cards'.
  useLayoutEffect(() => {
    if (revealing && wordsIn) row?.follow(from + Math.min(cards, CARD_BEATS));
  }, [revealing, wordsIn, row, from, cards]);

  // Everything has come in once the last word has settled and the cards' fade has played, or at
  // once when nothing can play them, so motion going and coming back never plays them again.
  useLayoutEffect(() => {
    const el = ref.current;
    if (settled || !wordsIn || el === null) return undefined;
    const comingIn = () =>
      el.getAnimations({ subtree: true }).some((a) => a instanceof CSSAnimation && COMING_IN.has(a.animationName) && a.playState !== 'finished');
    if (!comingIn()) {
      setSettled(true);
      return undefined;
    }
    const settle = () => {
      if (!comingIn()) setSettled(true);
    };
    el.addEventListener('animationend', settle);
    el.addEventListener('animationcancel', settle);
    return () => {
      el.removeEventListener('animationend', settle);
      el.removeEventListener('animationcancel', settle);
    };
  }, [ref, settled, wordsIn]);

  const revealed = useCallback((nth: number) => setWhole((count) => Math.max(count, nth + 1)), []);

  let className = '';
  if (revealing && !wordsIn) className = ' cd-claude-message--revealing';
  else if (!settled) className = ' cd-claude-message--following';
  return {
    revealing: revealing && !settled,
    drawn: revealing ? Math.min(whole + 1, prose) : prose,
    revealed,
    root: {
      className,
      // Assistive technology may wait for the whole reply rather than read it out word by word, or
      // twice: its words are drawn once more after they settle, and its cards come in after them.
      'aria-busy': revealing && !settled ? true : undefined,
      style: revealing ? ({ '--cd-follow-from': from } as CSSProperties) : undefined,
    },
  };
}
