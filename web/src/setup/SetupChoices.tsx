import { useEffect, useRef, useState } from 'react';
import type { Choice } from '../api/views.ts';
import { Card, IconButton } from '../ds/index.ts';
import { SETUP_COPY } from './copy.ts';

const copy = SETUP_COPY.questions;

/** Only the current question lives in the dock; its answer remains in the transcript. */
export function SetupChoices({ question, choices, disabled, onChoose, onDismiss }: {
  question: string;
  choices: Choice[];
  disabled: boolean;
  onChoose: (text: string) => void;
  onDismiss: () => void;
}) {
  const [other, setOther] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
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
      if (target.closest('.cd-icon-button')) return;
      const otherInput = target instanceof HTMLInputElement;
      const move = (index: number) => {
        setActive(index);
        root.current?.querySelectorAll<HTMLElement>('.cd-setup-q3__list button, .cd-setup-q3__list input')[index]?.focus({ preventScroll: true });
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
    <Card as="section" label={question} padding={16}>
      <div className="cd-setup-q3" ref={root}>
        <div className="cd-setup-q3__head">
          <p className="cd-setup-q3__question cd-type-reply">{question}</p>
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
              disabled={disabled} onFocus={() => setActive(choices.length)} onChange={(event) => setOther(event.target.value)} />
          </label></li>
        </ol>
        <p className="cd-setup-q3__hint cd-type-meta">
          <kbd className="cd-setup-kbd cd-type-meta">↑</kbd><kbd className="cd-setup-kbd cd-type-meta">↓</kbd> {copy.move}
          <kbd className="cd-setup-kbd cd-type-meta">1–{choices.length + 1}</kbd> {copy.pick}
          <kbd className="cd-setup-kbd cd-type-meta">Enter</kbd> {copy.send}
          <kbd className="cd-setup-kbd cd-type-meta">Esc</kbd> {copy.typeInstead}
        </p>
      </div>
    </Card>
  );
}
