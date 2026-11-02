import { useId, useRef } from 'react';

import { Button } from '../Button/Button.tsx';
import { CopyResult } from '../CopyResult/CopyResult.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { copyResultLine, useCopyText } from './useCopyText.ts';

import './CopyField.css';

export interface CopyFieldProps {
  /** What the value is, above it: "Key id", "Private key". Names the field. */
  label?: string;
  /** The value, exactly as a developer copies it: an address, a key id, a key. */
  value: string;
  /** The button's words in the page's language: "Copy address", "Copy key". Without it, no button. */
  copyLabel?: string;
  /** Copies `value`. The screen owns the clipboard; a throw or a rejection means it couldn't. */
  onCopy?: (value: string) => Promise<void> | void;
  /** A line beside the button, in the page's language: "Shown once. It’s a demo key for this Desk…". */
  note?: string;
  /** `inline`: the value on its line with the button at its right, as the endpoint is. `block`: the value in a box under its label, the button and the note under it, as a key is. */
  layout?: 'inline' | 'block';
  /** The page's language: the line after a copy, and `lang` on the field. */
  language: CopyLanguage;
}

/**
 * A value a developer copies, such as the agents page's endpoint or its demo key: in mono, marked
 * as machine text, with a copy button that calls the screen. When the copy fails, the value is
 * selected, and a line says it can be copied by hand. Nothing here touches the clipboard.
 */
export function CopyField({ label, value, copyLabel, onCopy, note, layout = 'inline', language }: CopyFieldProps) {
  const valueRef = useRef<HTMLElement>(null);
  const labelId = `${useId()}-label`;
  const { state, announcement, copy } = useCopyText(onCopy ?? (() => {}));
  const copies = copyLabel !== undefined && onCopy !== undefined;
  const result = copyResultLine(state, { language });

  const button = copies ? (
    <Button variant="secondary" size="main" onClick={() => void copy(value, valueRef.current)}>
      {copyLabel}
    </Button>
  ) : null;

  return (
    <div
      className={`cd-copy-field cd-copy-field--${layout}`}
      lang={language}
      role={label === undefined ? undefined : 'group'}
      aria-labelledby={label === undefined ? undefined : labelId}
    >
      {label === undefined ? null : (
        <p id={labelId} className="cd-copy-field__label cd-type-meta">
          {label}
        </p>
      )}
      <div className="cd-copy-field__row">
        <code ref={valueRef} className="cd-copy-field__value cd-type-code" data-copy="code" translate="no">
          {value}
        </code>
        {layout === 'inline' ? button : null}
      </div>
      {layout === 'block' && (button !== null || note !== undefined) ? (
        <div className="cd-copy-field__actions">
          {button}
          {note === undefined ? null : <p className="cd-copy-field__note cd-type-meta">{note}</p>}
        </div>
      ) : null}
      {copies ? (
        <CopyResult result={result} announcement={announcement} className="cd-copy-field__result cd-type-meta" />
      ) : null}
    </div>
  );
}
