import { useEffect, useId, useRef, useState } from 'react';
import type { Choice } from '../api/views.ts';
import { Card, ChatMarkdown, IconButton } from '../ds/index.ts';
import { Icon } from '../ds/icons/index.tsx';
import { SETUP_COPY } from './copy.ts';

const copy = SETUP_COPY.questions;

/**
 * Only the current question lives in the dock; its answer remains in the transcript. The memory
 * question (`consent`) docks the same way with its two answers only, as the setup boards draw it:
 * no dismiss and no "Something else…", since the message box stays under it, and no arrow keys in
 * its hint. There Esc goes to the message box and leaves the question docked.
 */
export function SetupChoices({ question, choices, maxLength, disabled, onChoose, onDismiss, kind = 'question' }: {
  question: string;
  choices: Choice[];
  maxLength: number;
  disabled: boolean;
  onChoose: (text: string) => void;
  onDismiss: () => void;
  kind?: 'question' | 'consent';
}) {
  const [other, setOther] = useState('');
  const [active, setActive] = useState(0);
  const offersOther = kind === 'question';
  /** The rows the keys move between: the choices, and "Something else…" where it is offered. */
  const rows = choices.length + (offersOther ? 1 : 0);
  const root = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  /**
   * What the owner has typed on a highlighted row since they last moved or sent: row digits that may be
   * the start of their words ("12 clients"), and whether a word has begun. It ends when focus leaves the
   * dock, or on a key that moves or picks (see the reset in the key handler).
   */
  const typed = useRef({ digits: '', word: false });
  const questionId = useId();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const inside = root.current?.contains(target);
      // What was typed on a row ends once the owner leaves it, or presses a key that isn't a character.
      // Shift and Caps Lock are part of typing ("2FA"). On the memory question so are Enter and the editing
      // keys: after typed words, Enter picks nothing, however often it's pressed and whatever was erased.
      const editing = ['Enter', 'Backspace', 'Delete', 'Dead', 'Process'].includes(event.key);
      const keeps = event.key === 'Shift' || event.key === 'CapsLock' || (editing && !offersOther);
      if ((!inside && target !== document.body) || (event.key.length !== 1 && !keeps)) typed.current = { digits: '', word: false };
      if (event.key === 'Escape' && (inside || target === document.body || target.closest('.cd-setup-dock textarea'))) {
        event.preventDefault(); onDismiss(); return;
      }
      // The composer's words and controls elsewhere keep their normal keys.
      if (!inside && target !== document.body) return;
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
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move((active + (event.key === 'ArrowDown' ? 1 : rows - 1)) % rows);
      } else if (!otherInput && /^[1-9]$/.test(event.key) && Number(event.key) <= rows) {
        event.preventDefault();
        const index = Number(event.key) - 1;
        const carried = typed.current.digits;
        if (offersOther && carried !== '' && index === choices.length) {
          // After digits typed on a row, "Something else…"'s own number can only be more of the number.
          typed.current = { digits: '', word: false };
          setOther((text) => `${text}${carried}${event.key}`.slice(0, maxLength));
          move(index);
        } else {
          move(index);
          // A row digit may begin the owner's words, and the next key says which. On the memory question a
          // digit picks its answer, which ends any words typed before it.
          typed.current = { digits: offersOther && index < choices.length ? carried + event.key : '', word: false };
        }
      } else if (offersOther && inside && !otherInput && event.key.length === 1 && (event.key !== ' ' || typed.current.digits !== '')) {
        // A highlighted row is a button, which takes no text: what the owner types goes to "Something
        // else…", with any row digits typed just before it, so Enter sends their words and never the row
        // they were on. Space on its own stays the row's key.
        event.preventDefault();
        const words = typed.current.digits + event.key;
        typed.current = { digits: '', word: false };
        setOther((text) => `${text}${words}`.slice(0, maxLength));
        move(choices.length);
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
        const text = offersOther && active === choices.length ? other.trim() : choices[active]?.text;
        if (text) onChoose(text);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [active, choices, disabled, maxLength, onChoose, onDismiss, other, offersOther, rows]);
  return (
    <div className="cd-setup-question-panel"><Card as="section" labelledBy={questionId} padding={16}>
      {/* Digits typed on a row are forgotten once focus leaves the dock, so a later answer doesn't start with them. */}
      <div className="cd-setup-q3" ref={root} onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) typed.current = { ...typed.current, digits: '' };
      }}>
        <div className="cd-setup-q3__scroll">
        <div className="cd-setup-q3__head">
          <div id={questionId} className="cd-setup-q3__question cd-type-reply"><ChatMarkdown text={question} links="open" /></div>
          {offersOther ? <IconButton label={copy.dismiss} icon="close" onClick={onDismiss} /> : null}
        </div>
        <ol className="cd-setup-q3__list" role="list">
          {choices.map((choice, index) => <li key={choice.text}>
            <button type="button" aria-label={choice.text} disabled={disabled}
              aria-current={active === index ? 'true' : undefined} onFocus={() => setActive(index)}
              className={`cd-setup-q3__row cd-type-body${index === active ? ' is-active' : ''}`}
              onClick={() => onChoose(choice.text)}>
              <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{index + 1}</kbd><span>{choice.text}</span>
            </button>
          </li>)}
          {offersOther ? <li><label className={`cd-setup-q3__row cd-setup-q3__row--other cd-type-body${active === choices.length ? ' is-active' : ''}`}>
            <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{choices.length + 1}</kbd>
            <input ref={otherRef} className="cd-type-body" aria-label={copy.other} placeholder={copy.other} value={other}
              maxLength={maxLength} disabled={disabled} onFocus={() => setActive(choices.length)} onChange={(event) => setOther(event.target.value)} />
          </label></li> : null}
        </ol>
        </div>
        <p className="cd-setup-q3__hint cd-type-meta">
          {offersOther ? <>
            <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} className="cd-setup-kbd__up" /><span className="cd-sr-only">{copy.upArrow}</span></kbd>
            <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} /><span className="cd-sr-only">{copy.downArrow}</span></kbd> {copy.move}
          </> : null}
          <kbd className="cd-setup-kbd cd-type-meta">1–{rows}</kbd> {copy.pick}
          <kbd className="cd-setup-kbd cd-type-meta">Enter</kbd> {copy.send}
          <kbd className="cd-setup-kbd cd-type-meta">Esc</kbd> {copy.typeInstead}
        </p>
      </div>
    </Card></div>
  );
}
