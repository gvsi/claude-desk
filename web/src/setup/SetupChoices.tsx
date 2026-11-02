import { useEffect, useId, useRef, useState } from 'react';
import type { Choice } from '../api/views.ts';
import { Button, Card, ChatMarkdown, IconButton } from '../ds/index.ts';
import { Icon } from '../ds/icons/index.tsx';
import { SETUP_COPY } from './copy.ts';

const copy = SETUP_COPY.questions;

/** A checkbox row's box: an empty edge, or filled with its check once picked. */
function Box({ checked }: { checked: boolean }) {
  return (
    <span className={`cd-setup-q3__box${checked ? ' is-checked' : ''}`} aria-hidden="true">
      {checked ? <Icon name="check" size={12} /> : null}
    </span>
  );
}

/**
 * What the owner has typed on a highlighted row, or on the page, since they last moved or sent: on a
 * question that takes one answer, row digits that may be the start of their words ("12 clients"); on
 * the memory question, whether a word has begun.
 */
interface Typed {
  digits: string;
  word: boolean;
}

const fresh = (): Typed => ({ digits: '', word: false });

/**
 * Only the current question lives in the dock; its answer remains in the transcript. The memory
 * question (`consent`) docks the same way with its two answers only, as the setup boards draw it:
 * no dismiss and no "Something else…", and no arrow keys in its hint. There Esc goes to the message
 * box and leaves the question docked.
 *
 * A question whose choices can be picked together (`several`) shows them as checkbox rows, as Claude
 * Code does: Space or a row's digit toggles it, and Enter or Send sends the picks with any words typed
 * in "Something else…", which count as picked once typed (`onPicks`).
 */
export function SetupChoices({ question, choices, maxLength, disabled, onChoose, onPicks, onDismiss, kind = 'question', several = false }: {
  question: string;
  choices: Choice[];
  maxLength: number;
  disabled: boolean;
  onChoose: (text: string) => void;
  /** A question that takes several: the picked choices' texts, in the listed order, and the typed words. */
  onPicks?: (picks: string[], text: string) => void;
  /** Esc or Dismiss: the words typed in "Something else…", which go on in the message box. */
  onDismiss: (words: string) => void;
  kind?: 'question' | 'consent';
  several?: boolean;
}) {
  const [other, setOther] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const offersOther = kind === 'question';
  const multiple = several && offersOther;
  /** The rows the keys move between: the choices, and "Something else…" where it is offered. */
  const rows = choices.length + (offersOther ? 1 : 0);
  const picks = choices.filter((_, index) => picked.has(index)).map((choice) => choice.text);
  const typedOther = other.trim();
  const root = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  /** What was typed on a row or the page (`Typed`); it ends when focus leaves the dock, or on a key that moves or sends. */
  const typed = useRef<Typed>(fresh());
  const questionId = useId();
  const toggle = (index: number) => setPicked((previous) => {
    const next = new Set(previous);
    if (!next.delete(index)) next.add(index);
    return next;
  });
  const sendPicks = () => {
    if (!disabled && (picks.length > 0 || typedOther !== '')) onPicks?.(picks, typedOther);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const inside = root.current?.contains(target);
      const onPage = target === document.body;
      if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
        // On the memory question, Enter or Space with a modifier never presses an answer after typed words either.
        if (!offersOther && inside && (event.key === 'Enter' || event.key === ' ') && typed.current.word) event.preventDefault();
        return;
      }
      // What was typed on a row ends once the owner leaves it. On a question it also ends on a key that
      // isn't a character, but Shift and Caps Lock, which are part of typing ("2FA"). On the memory question
      // words end only on a key that moves (the arrows up and down, Tab, Esc) or picks (a number key, below):
      // whatever else is pressed after them, Enter picks nothing.
      if (!inside && !onPage) typed.current = fresh();
      else if (offersOther ? event.key.length !== 1 && event.key !== 'Shift' && event.key !== 'CapsLock'
        : ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(event.key)) typed.current = fresh();
      if (event.key === 'Escape' && (inside || onPage || target.closest('.cd-setup-dock textarea'))) {
        event.preventDefault(); onDismiss(other); return;
      }
      // The composer's words and controls elsewhere keep their normal keys.
      if (!inside && !onPage) return;
      // So do Dismiss and a link in Claude's question: Enter opens the link.
      if (target.closest('.cd-icon-button, a[href]')) return;
      const otherInput = target === otherRef.current;
      const move = (index: number) => {
        setActive(index);
        const control = index === choices.length
          ? otherRef.current
          : root.current?.querySelectorAll<HTMLElement>('.cd-setup-q3__list button.cd-setup-q3__row')[index];
        control?.focus({ preventScroll: true });
        const area = root.current?.querySelector<HTMLElement>('.cd-setup-q3__scroll');
        const row = control?.closest('.cd-setup-q3__row');
        if (area && row) {
          const bounds = area.getBoundingClientRect();
          const rect = row.getBoundingClientRect();
          if (rect.top < bounds.top) area.scrollTop += rect.top - bounds.top;
          else if (rect.bottom > bounds.bottom) area.scrollTop += rect.bottom - bounds.bottom;
        }
      };
      /**
       * A key that makes the owner's words: it goes to "Something else…" with any row digits typed just
       * before it, so Enter sends their words and never a row they passed. Checkbox rows keep their ticks.
       */
      const toWords = (key: string) => {
        const { digits } = typed.current;
        typed.current = fresh();
        setOther((text) => `${text}${digits}${key}`.slice(0, maxLength));
        move(choices.length);
      };
      /** Space toggles a checkbox row only on the page or on a row; Send and the other controls keep their own Space. */
      const onRows = onPage || (!otherInput && target.closest('.cd-setup-q3__list') !== null);
      // Held down, a checkbox row's digit or Space toggles it once, not on every repeat.
      if (multiple && onRows && event.repeat && (event.key === ' ' || /^[1-9]$/.test(event.key))) {
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move((active + (event.key === 'ArrowDown' ? 1 : rows - 1)) % rows);
      } else if (!otherInput && /^[1-9]$/.test(event.key) && Number(event.key) <= rows) {
        event.preventDefault();
        const index = Number(event.key) - 1;
        const { digits } = typed.current;
        if (multiple) {
          // On checkbox rows each digit is a tick the owner sees: a choice's digit always toggles it, and
          // "Something else…"'s moves into it, keeping the ticks.
          typed.current = fresh();
          if (index < choices.length) toggle(index);
          move(index);
        } else if (offersOther && digits !== '' && index === choices.length) {
          // After digits typed on a row, "Something else…"'s own number can only be more of the number.
          toWords(event.key);
        } else {
          move(index);
          // A row digit may begin the owner's words, and the next key says which. On the memory question a
          // digit picks its answer, which ends any words typed before it.
          typed.current = { digits: offersOther && index < choices.length ? digits + event.key : '', word: false };
        }
      } else if (multiple && onRows && event.key === ' ') {
        // Space toggles the highlighted row.
        event.preventDefault();
        if (active < choices.length) toggle(active);
        move(active);
      } else if (offersOther && !otherInput && event.key.length === 1 && (event.key !== ' ' || typed.current.digits !== '')) {
        // A highlighted row is a button, and the page takes no text: what the owner types there goes to
        // "Something else…". Space on its own stays the row's key.
        event.preventDefault();
        toWords(event.key);
      } else if (!offersOther && inside && event.key.length === 1) {
        // The memory question takes only its two answers: words typed on one do nothing, and a space among
        // them presses neither, so "no thanks" can't be taken as yes.
        if (event.key !== ' ') typed.current.word = true;
        else if (typed.current.word) event.preventDefault();
      } else if (event.key === 'Enter') {
        // Reading the owner's memory and website takes a choice made in the panel, never an Enter from the page.
        if (!offersOther && !inside) return;
        event.preventDefault();
        // Words typed on the memory question pick nothing, Enter after them included: a digit, an arrow or a
        // click picks its answer.
        if (!offersOther && typed.current.word) return;
        if (multiple) {
          sendPicks();
          return;
        }
        const text = offersOther && active === choices.length ? other.trim() : choices[active]?.text;
        if (text) onChoose(text);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  });
  return (
    <div className="cd-setup-question-panel"><Card as="section" labelledBy={questionId} padding={16}>
      {/* Digits typed on a row are forgotten once focus leaves the dock, so a later answer doesn't start with them. */}
      <div className="cd-setup-q3" ref={root} onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) typed.current = { ...typed.current, digits: '' };
      }}>
        <div className="cd-setup-q3__scroll">
        <div className="cd-setup-q3__head">
          <div id={questionId} className="cd-setup-q3__question cd-type-reply"><ChatMarkdown text={question} links="open" /></div>
          {offersOther ? <IconButton label={copy.dismiss} icon="close" onClick={() => onDismiss(other)} /> : null}
        </div>
        <ol className={`cd-setup-q3__list${multiple ? ' cd-setup-q3__list--several' : ''}`} role="list">
          {choices.map((choice, index) => <li key={choice.text}>
            {multiple ? (
              <button type="button" role="checkbox" aria-checked={picked.has(index)} aria-label={choice.text} disabled={disabled}
                aria-current={active === index ? 'true' : undefined} onFocus={() => setActive(index)}
                className={`cd-setup-q3__row cd-type-body${index === active ? ' is-active' : ''}`}
                // A click is the owner's own pick: nothing typed before it carries into later words.
                onClick={() => { typed.current = fresh(); toggle(index); }}>
                <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{index + 1}</kbd><Box checked={picked.has(index)} /><span>{choice.text}</span>
              </button>
            ) : (
              <button type="button" aria-label={choice.text} disabled={disabled}
                aria-current={active === index ? 'true' : undefined} onFocus={() => setActive(index)}
                className={`cd-setup-q3__row cd-type-body${index === active ? ' is-active' : ''}`}
                onClick={() => onChoose(choice.text)}>
                <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{index + 1}</kbd><span>{choice.text}</span>
              </button>
            )}
          </li>)}
          {offersOther ? <li><label className={`cd-setup-q3__row cd-setup-q3__row--other cd-type-body${active === choices.length ? ' is-active' : ''}`}>
            <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{choices.length + 1}</kbd>
            {/* Typed words count as picked: the box fills once there are some. */}
            {multiple ? <Box checked={typedOther !== ''} /> : null}
            <input ref={otherRef} className="cd-type-body" aria-label={copy.other} placeholder={copy.other} value={other}
              maxLength={maxLength} disabled={disabled} onFocus={() => setActive(choices.length)} onChange={(event) => setOther(event.target.value)} />
          </label></li> : null}
        </ol>
        </div>
        <p className={`cd-setup-q3__hint cd-type-meta${multiple ? ' cd-setup-q3__hint--several' : ''}`}>
          {offersOther ? <>
            <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} className="cd-setup-kbd__up" /><span className="cd-sr-only">{copy.upArrow}</span></kbd>
            <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} /><span className="cd-sr-only">{copy.downArrow}</span></kbd> {copy.move}
          </> : null}
          {multiple ? <>
            <kbd className="cd-setup-kbd cd-type-meta">Space</kbd> {copy.toggle}
          </> : <>
            <kbd className="cd-setup-kbd cd-type-meta">1–{rows}</kbd> {copy.pick}
          </>}
          <kbd className="cd-setup-kbd cd-type-meta">Enter</kbd> {copy.send}
          <kbd className="cd-setup-kbd cd-type-meta">Esc</kbd> {copy.typeInstead}
          {multiple ? <>
            <span className="cd-setup-q3__hint-gap" aria-hidden="true" />
            <Button variant="primary" disabled={disabled || (picks.length === 0 && typedOther === '')} onClick={sendPicks}>{copy.sendPicks}</Button>
          </> : null}
        </p>
      </div>
    </Card></div>
  );
}
