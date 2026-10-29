/**
 * The checkout as a screen drives it, in a real browser: the screen answers a click by changing the
 * link's state or reporting an error, and the checkout follows. The stories cover each state as it
 * first renders; these cover what happens between them.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { rivera } from '../../fixtures/index.ts';
import { MockCheckout, type MockCheckoutProps } from './MockCheckout.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const AMOUNT = '$20.00';

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(() => {
  if (!mounted) return;
  const { root, container } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
});

/** Renders the checkout with these props; call the result again to re-render with new ones. */
function render(props: Partial<MockCheckoutProps> = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  const onPay = vi.fn();
  const onCancel = vi.fn();
  const base: MockCheckoutProps = {
    merchant: rivera.business.name,
    title: rivera.paymentLinks.issued.title,
    amount: AMOUNT,
    state: 'issued',
    language: 'en',
    onPay,
    onCancel,
    ...props,
  };
  const update = (next: Partial<MockCheckoutProps> = {}) => {
    act(() => root.render(<MockCheckout {...base} {...next} />));
  };
  update();
  return { container, onPay, onCancel, update };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

it('cancel_once_then_both_wait', () => {
  const { container, onPay, onCancel } = render();
  const pay = button(container, `Pay ${AMOUNT}`);
  const cancel = button(container, 'Cancel payment');
  // Two clicks in one go cancel once. Cancel then spins and Pay waits, and neither does more.
  act(() => {
    cancel.click();
    cancel.click();
  });
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(cancel.getAttribute('aria-busy')).toBe('true');
  expect(cancel.querySelector('.cd-button__spinner')).not.toBeNull();
  expect(pay.classList.contains('cd-button--waiting')).toBe(true);
  expect(pay.querySelector('.cd-button__spinner')).toBeNull();
  act(() => pay.click());
  expect(onPay).not.toHaveBeenCalled();
});

it('an_error_or_a_new_state_ends_the_request', () => {
  const { container, onPay, update } = render();
  const pay = () => button(container, `Pay ${AMOUNT}`);
  act(() => pay().click());
  expect(onPay).toHaveBeenCalledTimes(1);
  // The screen reports that the request failed: both buttons are at rest again, as the error board
  // draws them, and Pay can be tried once more. The kernel completes a link only while it is
  // issued, so a second try never pays twice.
  update({ error: true });
  for (const name of [`Pay ${AMOUNT}`, 'Cancel payment']) {
    expect(button(container, name).hasAttribute('aria-busy')).toBe(false);
    expect(button(container, name).hasAttribute('aria-disabled')).toBe(false);
  }
  act(() => pay().click());
  expect(onPay).toHaveBeenCalledTimes(2);
  expect(pay().getAttribute('aria-busy')).toBe('true');
  // A new state ends it too.
  update({ error: true, state: 'unknown' });
  update({ error: true, state: 'issued' });
  expect(pay().hasAttribute('aria-busy')).toBe(false);
});

it('the_line_takes_focus_when_the_link_closes_here', () => {
  // Paid after a click on Pay: the button that had focus is gone, so the line that says what
  // happened takes it, and a screen reader reads it.
  const paying = render();
  const pay = button(paying.container, `Pay ${AMOUNT}`);
  pay.focus();
  act(() => pay.click());
  paying.update({ state: 'paid' });
  const line = paying.container.querySelector<HTMLElement>('.cd-checkout__state');
  expect(document.activeElement).toBe(line);
  expect(line?.getAttribute('tabindex')).toBe('-1');
  expect(line?.textContent).toBe('Paid. Go back to the chat to see it there.');
});

it('a_page_that_opens_closed_leaves_focus_alone', () => {
  // A link that was already paid when the page opened: nothing moves focus.
  const { container } = render({ state: 'paid' });
  expect(container.contains(document.activeElement)).toBe(false);
});

it('focus_elsewhere_on_the_page_stays_there', () => {
  // The link expires while the visitor is somewhere else on the page: focus stays where it is.
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  document.body.append(elsewhere);
  try {
    const { update } = render();
    elsewhere.focus();
    update({ state: 'expired' });
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    elsewhere.remove();
  }
});

it('the_test_card_needs_no_name', () => {
  // Without a name from the screen, or with a blank one, the test card carries a test name, in
  // the page's language; a name the screen gives is shown as written, marked as someone's words.
  const nameOn = (container: HTMLElement) => container.querySelector('.cd-checkout__field--name .cd-checkout__value');
  const page = render();
  expect(nameOn(page.container)?.textContent).toBe('Test customer');
  expect(nameOn(page.container)?.hasAttribute('data-copy')).toBe(false);
  page.update({ language: 'es' });
  expect(nameOn(page.container)?.textContent).toBe('Cliente de prueba');
  page.update({ cardName: '  ' });
  expect(nameOn(page.container)?.textContent).toBe('Test customer');
  page.update({ cardName: rivera.people.dana.name });
  expect(nameOn(page.container)?.textContent).toBe(rivera.people.dana.name);
  expect(nameOn(page.container)?.getAttribute('data-copy')).toBe('user');
});

it('a_state_this_build_does_not_know_can_not_be_paid', () => {
  // Only `issued` can be paid. Anything else, a state added later included, shows no buttons and
  // reads as still being confirmed, with the chat as where the result shows.
  const { container } = render({ state: 'refunded' as MockCheckoutProps['state'] });
  expect(container.querySelectorAll('button')).toHaveLength(0);
  expect(container.textContent).not.toContain(AMOUNT);
  const line = container.querySelector('.cd-checkout__state');
  expect(line?.textContent).toBe('This payment is still being confirmed. The chat will show the result.');
  expect(line?.querySelector('.cd-status-dot--held')).not.toBeNull();
});
