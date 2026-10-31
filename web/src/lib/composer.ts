export interface FillComposerOptions {
  /** Moves focus into the box, with the caret at the end of the words (default true). */
  focus?: boolean;
}

/**
 * Puts `text` in a design system Composer's text box as if it had been typed, so the Composer
 * takes it as its own (it keeps its text itself and takes none from outside), then, unless asked
 * not to, focuses the box with the caret at the end. Used to give back words that didn't send, and
 * to type in a "Try to break it" idea a link named.
 */
export function fillComposer(box: HTMLTextAreaElement, text: string, { focus = true }: FillComposerOptions = {}): void {
  // The prototype's setter, so React sees the change, then the input event it listens for.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  if (!focus) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}
