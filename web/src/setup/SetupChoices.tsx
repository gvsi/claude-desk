import { useEffect, useId, useRef, useState } from 'react';
import type { Choice } from '../api/views.ts';
import { Card, ChatMarkdown, IconButton } from '../ds/index.ts';
import { Icon } from '../ds/icons/index.tsx';
import { SETUP_COPY } from './copy.ts';

const copy = SETUP_COPY.questions;

/** Only the current question lives in the dock; its answer remains in the transcript. */
export function SetupChoices({ question, choices, maxLength, disabled, onChoose, onDismiss }: {
  question: string;
  choices: Choice[];
  maxLength: number;
  disabled: boolean;
  onChoose: (text: string) => void;
  onDismiss: () => void;
}) {
  const [other, setOther] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const questionId = useId();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const inside = root.current?.contains(target);
      if (event.key === 'Escape' && (inside || target === document.body || target.closest('.cd-setup-dock textarea'))) {
        event.preventDefault(); onDismiss(); return;
      }
      // The composer's words and controls elsewhere keep their normal keys.
      if (!inside && target !== document.body) return;
      // So do Dismiss and a link in Claude's question: Enter opens the link.
      if (target.closest('.cd-icon-button, a[href]')) return;
      const otherInput = target instanceof HTMLInputElement;
      const move = (index: number) => {
        setActive(index);
        const control = root.current?.querySelectorAll<HTMLElement>('.cd-setup-q3__list button, .cd-setup-q3__list input')[index];
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
        move((active + (event.key === 'ArrowDown' ? 1 : choices.length)) % (choices.length + 1));
      } else if (!otherInput && /^[1-9]$/.test(event.key) && Number(event.key) <= choices.length + 1) {
        event.preventDefault(); move(Number(event.key) - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const text = active === choices.length ? other.trim() : choices[active]?.text;
        if (text) onChoose(text);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [active, choices, disabled, onChoose, onDismiss, other]);
  return (
    <div className="cd-setup-question-panel"><Card as="section" labelledBy={questionId} padding={16}>
      <div className="cd-setup-q3" ref={root}>
        <div className="cd-setup-q3__scroll">
        <div className="cd-setup-q3__head">
          <div id={questionId} className="cd-setup-q3__question cd-type-reply"><ChatMarkdown text={question} /></div>
          <IconButton label={copy.dismiss} icon="close" onClick={onDismiss} />
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
          <li><label className={`cd-setup-q3__row cd-setup-q3__row--other cd-type-body${active === choices.length ? ' is-active' : ''}`}>
            <kbd className="cd-setup-kbd cd-type-meta" aria-hidden="true">{choices.length + 1}</kbd>
            <input className="cd-type-body" aria-label={copy.other} placeholder={copy.other} value={other}
              maxLength={maxLength} disabled={disabled} onFocus={() => setActive(choices.length)} onChange={(event) => setOther(event.target.value)} />
          </label></li>
        </ol>
        </div>
        <p className="cd-setup-q3__hint cd-type-meta">
          <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} className="cd-setup-kbd__up" /><span className="cd-sr-only">{copy.upArrow}</span></kbd>
          <kbd className="cd-setup-kbd cd-setup-kbd--arrow cd-type-meta"><Icon name="chevron-down" size={14} /><span className="cd-sr-only">{copy.downArrow}</span></kbd> {copy.move}
          <kbd className="cd-setup-kbd cd-type-meta">1–{choices.length + 1}</kbd> {copy.pick}
          <kbd className="cd-setup-kbd cd-type-meta">Enter</kbd> {copy.send}
          <kbd className="cd-setup-kbd cd-type-meta">Esc</kbd> {copy.typeInstead}
        </p>
      </div>
    </Card></div>
  );
}
