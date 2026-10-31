import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import { IconButton } from '../IconButton/IconButton.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';

import './Composer.css';

/**
 * `owner`: the hero composer of Today and Rules, its controls in a row under the text.
 * `visitor` and `whisper`: one row with the send button at the end, on the public page and in a
 * conversation.
 */
export type ComposerVariant = 'owner' | 'visitor' | 'whisper';

export interface ComposerProps {
  variant: ComposerVariant;
  /** The text box's name, read by screen readers: "Message Rivera Plumbing". */
  label: string;
  /** Shown in the empty text box. */
  placeholder: string;
  /** One quiet line about what happens to the words: "Rule changes are shown to you before they apply." */
  helper?: string;
  /** The send button's name; "Send" (`owner`, `visitor`) or "Send whisper" (`whisper`) by default. */
  sendLabel?: string;
  disabled?: boolean;
  /** Caps the text at this many characters, with a counter from 90% of it. */
  maxLength?: number;
  /** Called with the trimmed text, never empty; the composer then clears. */
  onSend: (text: string) => void;
  /** Adds "Add a photo or file". */
  onAttach?: () => void;
  /** Adds "Speak instead". */
  onSpeak?: () => void;
  /**
   * Vision pages only, which make no requests: typing works and Send keeps its look, but Send and
   * Enter do nothing. `onSend` is never called and the text stays.
   */
  inertSend?: boolean;
}

const SEND_LABEL = {
  owner: 'Send',
  visitor: 'Send',
  whisper: 'Send whisper',
} as const satisfies Record<ComposerVariant, string>;

/** The share of `maxLength` from which the counter shows. */
const COUNTER_FROM = 0.9;

/** Safari reports the Enter that confirms an IME word as key code 229, after compositionend. */
const IME_KEY_CODE = 229;

/**
 * The text box people write in: a raised surface that grows with the text up to six lines. Enter
 * sends, Shift+Enter starts a new line, and an Enter that confirms an IME word does neither.
 */
export function Composer({
  variant,
  label,
  placeholder,
  helper,
  sendLabel,
  disabled = false,
  maxLength,
  onSend,
  onAttach,
  onSpeak,
  inertSend = false,
}: ComposerProps) {
  const id = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [value, setValue] = useState('');
  // On a vision page: whether Send has been pressed, so its line shows from then on.
  const [inertPressed, setInertPressed] = useState(false);

  const text = value.trim();
  const canSend = !disabled && text !== '';
  const showCounter = maxLength !== undefined && value.length >= maxLength * COUNTER_FROM;
  const inputId = `${id}-input`;
  const helperId = helper ? `${id}-helper` : undefined;
  const counterId = showCounter ? `${id}-counter` : undefined;
  const describedBy = [helperId, counterId].filter(Boolean).join(' ') || undefined;

  // Grow with the text: the height follows the content, and the stylesheet caps it at six lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [value]);

  const send = () => {
    if (!canSend) return;
    // A vision page's composer: the words go nowhere, so they stay, and the line says why.
    if (inertSend) {
      setInertPressed(true);
      return;
    }
    onSend(text);
    setValue('');
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(maxLength === undefined ? next : next.slice(0, maxLength));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === IME_KEY_CODE) return;
    event.preventDefault();
    send();
  };

  const input = (
    <textarea
      ref={inputRef}
      id={inputId}
      className="cd-composer__input cd-type-message"
      rows={1}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      aria-describedby={describedBy}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    />
  );
  const attach = onAttach ? <IconButton label="Add a photo or file" icon="plus" disabled={disabled} onClick={() => onAttach()} /> : null;
  const speak = onSpeak ? <IconButton label="Speak instead" icon="mic" disabled={disabled} onClick={() => onSpeak()} /> : null;
  const sendButton = (
    <IconButton
      label={sendLabel ?? SEND_LABEL[variant]}
      icon="send"
      variant="primary"
      shape="round"
      disabled={!canSend}
      onClick={() => {
        send();
        // On a vision page nothing was sent, so Send keeps the focus.
        if (inertSend) return;
        // The button is disabled once the text clears, so the next message starts in the text box.
        inputRef.current?.focus();
      }}
    />
  );
  const helperLine = helper ? (
    <span id={helperId} className="cd-composer__helper cd-type-caption">
      {helper}
    </span>
  ) : null;
  const counter = showCounter ? (
    <span id={counterId} className="cd-composer__counter cd-type-caption">
      {value.length} / {maxLength}
    </span>
  ) : null;
  const inertLine = inertSend ? <VisionInertLine shown={inertPressed} /> : null;
  const labelElement = (
    <label htmlFor={inputId} className="cd-sr-only">
      {label}
    </label>
  );

  if (variant === 'owner') {
    return (
      <div className="cd-composer cd-composer--owner">
        <div className="cd-composer__box cd-composer__box--stacked">
          {labelElement}
          {input}
          <div className="cd-composer__tools">
            {attach}
            {helperLine ?? <span className="cd-composer__helper" />}
            {counter}
            {speak}
            {sendButton}
          </div>
        </div>
        {inertLine}
      </div>
    );
  }

  return (
    <div className={`cd-composer cd-composer--${variant}`}>
      <div className="cd-composer__box cd-composer__box--inline">
        {labelElement}
        {attach}
        {input}
        {speak}
        {sendButton}
      </div>
      {helperLine || counter ? (
        <div className="cd-composer__meta">
          {helperLine}
          {counter}
        </div>
      ) : null}
      {inertLine}
    </div>
  );
}
