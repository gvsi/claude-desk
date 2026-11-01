/**
 * The control the click being handled landed on, for a panel that click opens. Safari focuses no
 * button a click presses, so while the click is handled `document.activeElement` is the page's body,
 * not the button that opened the panel. A capture listener on the document notes the control each
 * click lands on, and forgets it once the click's task is over: a panel the click opens is mounted
 * within that task, and a panel that opens later never takes an old click for its opener.
 */

/** What a click can land on and focus can return to. */
const CONTROL = 'a[href], button, input, select, textarea, summary, [tabindex]';

/** The click being handled, if any; each click is its own object, so a late reset can't clear the next. */
let current: { control: HTMLElement | null } | null = null;

function noteClick(event: MouseEvent): void {
  const { target } = event;
  const click = { control: target instanceof Element ? target.closest<HTMLElement>(CONTROL) : null };
  current = click;
  setTimeout(() => {
    if (current === click) current = null;
  }, 0);
}

if (typeof document !== 'undefined') document.addEventListener('click', noteClick, { capture: true });

/** The control the click being handled landed on, while it is still on the page. */
export function clickedControl(): HTMLElement | null {
  const control = current?.control ?? null;
  return control?.isConnected ? control : null;
}
