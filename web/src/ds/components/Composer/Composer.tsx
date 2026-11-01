import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { Notice } from '../Notice/Notice.tsx';
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
  /**
   * A reply is coming in: typing works and the text box keeps focus, but Send is disabled and Enter
   * does nothing. The text stays.
   */
  sendHeld?: boolean;
  /** Caps the text at this many characters, with a counter from 90% of it. */
  maxLength?: number;
  /** Called with the trimmed text, never empty; the composer then clears. */
  onSend: (text: string) => void;
  /** Adds "Add a photo or file". */
  onAttach?: () => void;
  /** Adds "Speak instead". */
  onSpeak?: () => void;
  /**
   * What was sent couldn't be answered: the screen's `line` over the composer's box, which keeps
   * `text`, the words as sent, beside "Try again" (`onRetry`). Nothing can be typed until it clears.
   */
  failed?: ComposerFailed;
  /**
   * Vision pages only, which make no requests: typing works and Send keeps its look, but Send and
   * Enter do nothing. `onSend` is never called and the text stays. While `failed` is set, the failed
   * box shows instead and no vision line is drawn.
   */
  inertSend?: boolean;
}

/** A send that failed, kept in the composer until the screen tries again. */
export interface ComposerFailed {
  /** The words that were sent, as `onSend` got them. */
  text: string;
  /** What happened and what to do, in the screen's words: "I couldn't answer just now. Your answer is still here; try again." */
  line: string;
  /** The button's words, "Try again" by default; a screen in another language passes its own ("Intentar de nuevo"). */
  retryLabel?: string;
  /**
   * The button: the screen sends `text` again, passing `disabled` while that send is in flight,
   * and clears `failed` once it goes through.
   */
  onRetry: () => void;
}

/** The failed state's button, unless the screen names it. */
const RETRY_LABEL = 'Try again';

const SEND_LABEL = {
  owner: 'Send',
  visitor: 'Send',
  whisper: 'Send whisper',
} as const satisfies Record<ComposerVariant, string>;

/** The share of `maxLength` from which the counter shows. */
const COUNTER_FROM = 0.9;

/** Safari reports the Enter that confirms an IME word as key code 229, after compositionend. */
const IME_KEY_CODE = 229;

/** What on the box keeps its own click: its text box and controls, and the counter. */
const OWN_CLICK = 'textarea, button, a, input, select, label, [role="button"], [tabindex], .cd-composer__counter';

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
  sendHeld = false,
  maxLength,
  onSend,
  onAttach,
  onSpeak,
  failed,
  inertSend = false,
}: ComposerProps) {
  const id = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const failedBoxRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [value, setValue] = useState('');
  // On a vision page: whether Send has been pressed, so its line shows from then on.
  const [inertPressed, setInertPressed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isFailed = failed !== undefined;
  const shownFailed = useRef(isFailed);
  const ownFocusAtSwap = useRef(false);
  // A failed send takes the text box's place, and trying again gives it back, removing the control
  // that had focus. Note, as the swap renders and while the old control is still on the page,
  // whether one of the composer's own controls has focus; nothing drawn depends on it.
  if (shownFailed.current !== isFailed && typeof document !== 'undefined') {
    ownFocusAtSwap.current = rootRef.current?.contains(document.activeElement) ?? false;
  }

  const text = value.trim();
  const canSend = !disabled && !sendHeld && text !== '';
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
  }, [value, isFailed]);

  // After the swap, focus follows to the control in the removed one's place ("Try again", or the
  // text box) only when the composer's own control had it. Focus the owner left elsewhere, on
  // another control or on the page itself, stays there, and a composer that opens failed takes none.
  useLayoutEffect(() => {
    if (shownFailed.current === isFailed) return;
    shownFailed.current = isFailed;
    const follow = ownFocusAtSwap.current;
    ownFocusAtSwap.current = false;
    if (!follow) return;
    if (isFailed) failedBoxRef.current?.querySelector<HTMLElement>('button')?.focus();
    else inputRef.current?.focus();
  }, [isFailed]);

  // A click on the box away from its controls (its padding, the row under the text) puts the caret
  // at the end of the text, as on claude.ai. Only a press that starts there counts, so a selection
  // made in the text box and released outside it stays, and the press itself moves no focus.
  const pressedBox = useRef(false);
  const ownClick = (target: EventTarget) => !(target instanceof Element) || target.closest(OWN_CLICK) !== null;
  const handleBoxMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    pressedBox.current = event.button === 0 && !disabled && !ownClick(event.target);
    if (pressedBox.current) event.preventDefault();
  };
  const handleBoxClick = (event: MouseEvent<HTMLDivElement>) => {
    const pressed = pressedBox.current;
    pressedBox.current = false;
    const box = inputRef.current;
    if (!pressed || disabled || !box || ownClick(event.target)) return;
    // Words already selected in the text box stay selected.
    if (document.activeElement === box && box.selectionStart !== box.selectionEnd) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  };

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

  if (failed) {
    return (
      <div ref={rootRef} className="cd-composer cd-composer--failed">
        <Notice tone="error">{failed.line}</Notice>
        <div ref={failedBoxRef} role="group" aria-label={label} className="cd-composer__box cd-composer__box--failed">
          <span className="cd-composer__kept cd-type-body" data-copy="user" tabIndex={0} role="region" aria-label={label}>
            {failed.text}
          </span>
          {/* While the screen sends again (`disabled`), it waits: focus stays, and nothing is called. */}
          <Button variant="primary" waiting={disabled} onClick={() => failed.onRetry()}>
            {failed.retryLabel ?? RETRY_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  if (variant === 'owner') {
    return (
      <div ref={rootRef} className="cd-composer cd-composer--owner">
        <div className="cd-composer__box cd-composer__box--stacked" onMouseDown={handleBoxMouseDown} onClick={handleBoxClick}>
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
    <div ref={rootRef} className={`cd-composer cd-composer--${variant}`}>
      <div className="cd-composer__box cd-composer__box--inline" onMouseDown={handleBoxMouseDown} onClick={handleBoxClick}>
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
