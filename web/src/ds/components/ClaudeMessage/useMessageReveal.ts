import { useCallback, useContext, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

import { useReducedMotion } from '../ChatMarkdown/useReducedMotion.ts';
import { RowArrivalContext } from '../TranscriptRow/arrival.ts';

/** The cards' fade and rise, after a revealed message's words (ClaudeMessage.css). */
const FOLLOW = 'cd-claude-message-follow';

/** From the third card on, cards share a beat, so a long list never keeps what follows waiting. */
const CARD_BEATS = 3;

export interface MessageReveal {
  /** The message is revealed: it arrived live, with motion. Read once, when first drawn. */
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
 * and the `TranscriptRow` it arrived in brings what is attached in after them. Not revealed, it
 * shows whole at once.
 */
export function useMessageReveal(ref: RefObject<HTMLElement | null>, prose: number, cards: number, reveal: boolean): MessageReveal {
  const reduced = useReducedMotion();
  const [revealing] = useState(reveal && !reduced);
  // How many prose blocks show all their words.
  const [whole, setWhole] = useState(revealing ? 0 : prose);
  const wordsIn = whole >= prose;
  // Whether the cards have come in: at once when the message isn't revealed.
  const [cardsIn, setCardsIn] = useState(!revealing);
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

  // The cards have come in once their fade has played, or at once when nothing can play it, so
  // motion going and coming back never plays it again.
  useLayoutEffect(() => {
    const el = ref.current;
    if (cardsIn || !wordsIn || el === null) return undefined;
    const following = () =>
      el.getAnimations({ subtree: true }).some((a) => a instanceof CSSAnimation && a.animationName === FOLLOW && a.playState !== 'finished');
    if (!following()) {
      setCardsIn(true);
      return undefined;
    }
    const settle = () => {
      if (!following()) setCardsIn(true);
    };
    el.addEventListener('animationend', settle);
    el.addEventListener('animationcancel', settle);
    return () => {
      el.removeEventListener('animationend', settle);
      el.removeEventListener('animationcancel', settle);
    };
  }, [ref, cardsIn, wordsIn]);

  const revealed = useCallback((nth: number) => setWhole((count) => Math.max(count, nth + 1)), []);

  let className = '';
  if (revealing && !wordsIn) className = ' cd-claude-message--revealing';
  else if (revealing && !cardsIn) className = ' cd-claude-message--following';
  return {
    revealing,
    drawn: revealing ? Math.min(whole + 1, prose) : prose,
    revealed,
    root: {
      className,
      // Assistive technology may wait for the whole reply rather than read it out word by word.
      'aria-busy': revealing && !wordsIn ? true : undefined,
      style: revealing ? ({ '--cd-follow-from': from } as CSSProperties) : undefined,
    },
  };
}
