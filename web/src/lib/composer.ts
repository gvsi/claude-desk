/**
 * Puts `text` in a design system Composer's text box as if it had been typed, so the Composer
 * takes it as its own (it keeps its text itself and takes none from outside), then focuses the box
 * with the caret at the end. Used to give back words that didn't send.
 */
export function fillComposer(box: HTMLTextAreaElement, text: string): void {
  // The prototype's setter, so React sees the change, then the input event it listens for.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}
