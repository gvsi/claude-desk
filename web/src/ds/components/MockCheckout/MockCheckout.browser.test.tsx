/**
 * The checkout as a screen drives it, in a real browser: the screen answers a click by changing the
 * link's state or reporting an error, and the checkout follows. The stories cover each state as it
 * first renders; these cover what happens between them.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

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

/** The checkout's result region: polite, atomic, and there in every state. */
function resultRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('.cd-checkout__card [role="status"]');
  if (!region) throw new Error('no result region');
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.getAttribute('aria-atomic')).toBe('true');
  return region;
}

it('the_title_takes_focus_when_the_link_closes_here', () => {
  // Paid after a click on Pay: the button that had focus is gone, so the card's title takes it,
  // and the result region, there and empty while the link was open, announces the line once.
  const paying = render();
  const before = resultRegion(paying.container);
  expect(before.textContent).toBe('');
  const pay = button(paying.container, `Pay ${AMOUNT}`);
  pay.focus();
  act(() => pay.click());
  paying.update({ state: 'paid' });
  const title = paying.container.querySelector<HTMLElement>('h1');
  expect(document.activeElement).toBe(title);
  expect(title?.getAttribute('tabindex')).toBe('-1');
  const region = resultRegion(paying.container);
  expect(region).toBe(before);
  expect(region.textContent).toBe('Paid. Go back to the chat to see it there.');
});

it('a_later_result_is_announced_and_focus_stays_put', () => {
  // Still being confirmed, then paid, while the visitor is elsewhere on the page: the same
  // region announces the new line, and focus stays where it was.
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  document.body.append(elsewhere);
  try {
    const { container, update } = render({ state: 'unknown' });
    const region = resultRegion(container);
    expect(region.textContent).toBe('This payment is still being confirmed. The chat will show the result.');
    elsewhere.focus();
    update({ state: 'paid' });
    expect(resultRegion(container)).toBe(region);
    expect(region.textContent).toBe('Paid. Go back to the chat to see it there.');
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    elsewhere.remove();
  }
});

it('a_page_that_opens_closed_leaves_focus_alone', () => {
  // A link that was already paid when the page opened: nothing moves focus.
  const { container } = render({ state: 'paid' });
  expect(container.contains(document.activeElement)).toBe(false);
});

it('focus_elsewhere_on_the_page_stays_there', async () => {
  // The link expires while the visitor is somewhere else on the page: focus stays where it is.
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  document.body.append(elsewhere);
  try {
    const { container, update } = render();
    const title = () => container.querySelector('h1');
    elsewhere.focus();
    update({ state: 'expired' });
    expect(document.activeElement).toBe(elsewhere);

    // Nothing has focus when the link expires: focus stays with the page, and the title doesn't
    // take it, since focus was never in the card.
    update({ state: 'issued' });
    elsewhere.blur();
    expect(document.activeElement).toBe(document.body);
    update({ state: 'expired' });
    expect(document.activeElement).toBe(document.body);
    expect(title()).not.toBe(document.activeElement);

    // Focus was in the card, then left it for nothing before the link expired: the same.
    update({ state: 'issued' });
    const pay = button(container, `Pay ${AMOUNT}`);
    pay.focus();
    pay.blur();
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
    update({ state: 'expired' });
    expect(document.activeElement).toBe(document.body);
  } finally {
    elsewhere.remove();
  }
});

it('the_name_comes_only_from_the_link', () => {
  // A link from a verified session carries the customer's name: it shows read-only, like the
  // other test card values, marked as someone's words. Without one, or with a blank one, the name
  // is an empty field to type in, in the page's language.
  const nameOn = (container: HTMLElement) => container.querySelector('.cd-checkout__field--name .cd-checkout__value');
  const page = render({ customerName: 'Dana W.' });
  expect(nameOn(page.container)?.textContent).toBe('Dana W.');
  expect(nameOn(page.container)?.getAttribute('data-copy')).toBe('user');
  expect(page.container.querySelector('input')).toBeNull();
  for (const customerName of [undefined, '', '  ']) {
    page.update({ customerName });
    const field = page.container.querySelector('input');
    expect(field?.value).toBe('');
    expect(field?.readOnly).toBe(false);
    expect(field?.labels?.[0]?.textContent).toBe('Name on card');
    expect(nameOn(page.container)).toBeNull();
  }
  page.update({ language: 'es', customerName: undefined });
  const field = page.container.querySelector('input');
  expect(field?.labels?.[0]?.textContent).toBe('Nombre en la tarjeta');
  // The field's own hint, in the page's language, describes it.
  const hintId = field?.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(hintId)?.textContent).toBe('Cualquier nombre sirve. Se queda en esta página.');
});

it('a_typed_name_reaches_no_callback', async () => {
  // The name typed stays in the field: Enter submits nothing, and Cancel says only that it was
  // pressed. The page has no form to send it with.
  const { container, onPay, onCancel } = render();
  const field = container.querySelector('input');
  if (!field) throw new Error('no name field');
  expect(field.form).toBeNull();
  await act(async () => {
    await userEvent.type(field, 'Ana López{Enter}');
  });
  expect(field.value).toBe('Ana López');
  expect(onPay).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  act(() => button(container, 'Cancel payment').click());
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onCancel.mock.calls[0]).toEqual([]);
});

it('clearing_an_old_error_keeps_a_retry_locked', () => {
  const { container, onPay, onCancel, update } = render();
  const pay = () => button(container, `Pay ${AMOUNT}`);
  const cancel = () => button(container, 'Cancel payment');
  act(() => pay().click());
  update({ error: true });
  // A retry, then the screen clears the old error as the retry starts: the retry is still in
  // flight, so the buttons stay locked and nothing more is sent.
  act(() => pay().click());
  update({ error: false });
  expect(pay().getAttribute('aria-busy')).toBe('true');
  act(() => {
    pay().click();
    cancel().click();
  });
  expect(onPay).toHaveBeenCalledTimes(2);
  expect(onCancel).not.toHaveBeenCalled();
  // The retry fails too: the buttons are back.
  update({ error: true });
  expect(pay().hasAttribute('aria-busy')).toBe(false);
  expect(cancel().hasAttribute('aria-disabled')).toBe(false);
});

it('a_retried_cancel_keeps_its_spinner', () => {
  const { container, onPay, onCancel, update } = render();
  const pay = () => button(container, `Pay ${AMOUNT}`);
  const cancel = () => button(container, 'Cancel payment');
  act(() => pay().click());
  update({ error: true });
  // The visitor cancels instead, and the screen clears the old error and says it is busy: Cancel
  // is the one in flight, so it spins and Pay waits.
  act(() => cancel().click());
  update({ error: false, busy: true });
  expect(cancel().getAttribute('aria-busy')).toBe('true');
  expect(cancel().querySelector('.cd-button__spinner')).not.toBeNull();
  expect(pay().classList.contains('cd-button--waiting')).toBe(true);
  expect(pay().querySelector('.cd-button__spinner')).toBeNull();
  expect(onPay).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledTimes(1);
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

it('the_cancelled_line_reuses_the_paid_link_in_every_language', () => {
  const CHAT = '/d/turner-plumbing-abc123';
  const { container, update } = render({ state: 'paid', chatHref: CHAT });
  const region = () => resultRegion(container);
  for (const [language, paid, cancelled, label] of [
    ['en', 'Paid. Go back to the chat to see it there.', 'This payment was cancelled. Nothing was charged.', 'Go back to the chat'],
    ['es', 'Pagado. Vuelve al chat para verlo allí.', 'Este pago se canceló. No se cobró nada.', 'Vuelve al chat'],
  ] as const) {
    update({ state: 'paid', language });
    expect(region().textContent).toBe(paid);
    const paidLink = region().querySelector('a');
    expect(paidLink?.getAttribute('href')).toBe(CHAT);
    expect(paidLink?.getAttribute('target')).toBeNull();

    update({ state: 'cancelled', language });
    const back = region().querySelector('a');
    expect(back).not.toBeNull();
    expect(back?.textContent).toBe(label);
    expect(back?.getAttribute('href')).toBe(paidLink?.getAttribute('href'));
    expect(back?.getAttribute('target')).toBeNull();
    expect(back?.classList.contains('cd-text-link--running-text')).toBe(true);
    expect(region().textContent).toBe(`${cancelled} ${label}.`);

    for (const chatHref of [undefined, '', 'https://evil.example/d/rivera', '//evil.example', '/d/rivera?preview=desk-1', '/d/rivera#about', '/d/rivera/agents', '/d/Turner', 'javascript:alert(1)', '/pay/k7Hq2vX9']) {
      update({ state: 'cancelled', language, chatHref });
      expect(region().querySelector('a'), chatHref).toBeNull();
      expect(region().textContent).toBe(cancelled);
    }
  }
});

it('expired_and_rule_change_lines_link_only_the_chat_words_to_a_valid_chat', () => {
  const CHAT = '/d/turner-plumbing-abc123';
  const { container, update } = render();
  for (const [language, label, expired, rulesChanged] of [
    ['en', 'the chat', 'This payment link expired. Ask in the chat for a new one.', 'This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay.'],
    ['es', 'el chat', 'Este enlace de pago venció. Pide uno nuevo en el chat.', 'Este enlace se canceló porque el negocio cambió sus reglas. No se cobró nada. Pregunta en el chat si todavía quieres pagar.'],
  ] as const) {
    for (const state of ['expired', 'cancelled'] as const) {
      const line = state === 'expired' ? expired : rulesChanged;
      update({ state, language, cancelReason: 'rules_changed', chatHref: CHAT });
      const region = resultRegion(container);
      expect(region.textContent).toBe(line);
      expect(region.querySelectorAll('a')).toHaveLength(1);
      const back = region.querySelector('a');
      expect(back?.textContent).toBe(label);
      expect(back?.getAttribute('href')).toBe(CHAT);
      expect(back?.getAttribute('target')).toBeNull();
      expect(back?.classList.contains('cd-text-link--running-text')).toBe(true);

      for (const chatHref of [undefined, '', 'https://evil.example/d/rivera', '//evil.example', '/d/rivera?preview=desk-1', '/d/rivera#about', '/d/rivera/agents', '/d/Turner', 'javascript:alert(1)', '/pay/k7Hq2vX9']) {
        update({ state, language, cancelReason: 'rules_changed', chatHref });
        expect(region.querySelector('a'), chatHref).toBeNull();
        expect(region.textContent).toBe(line);
      }
    }
  }
});

it('the_paid_line_links_back_only_to_a_public_chat', () => {
  // Paid, with the visitor's chat known: the line's own words, with "Go back to the chat" a text
  // link in the sentence to that chat, in the same tab.
  const CHAT = '/d/turner-plumbing-abc123';
  const { container, update } = render({ state: 'paid', chatHref: CHAT });
  const line = () => container.querySelector('.cd-checkout__state');
  // The footer's author link aside, the only link on the page.
  const links = () => [...container.querySelectorAll('a')].filter((a) => !a.matches('[data-ds="concept-footer"] a'));
  expect(line()?.textContent).toBe('Paid. Go back to the chat to see it there.');
  expect(links()).toHaveLength(1);
  const [back] = links();
  expect(back?.textContent).toBe('Go back to the chat');
  expect(back?.getAttribute('href')).toBe(CHAT);
  expect(back?.getAttribute('target')).toBeNull();
  expect(back?.classList.contains('cd-text-link--running-text')).toBe(true);
  expect(back?.closest('.cd-checkout__state')).toBe(line());
  expect(resultRegion(container).textContent).toBe('Paid. Go back to the chat to see it there.');

  // In Spanish, "Vuelve al chat" is the link.
  update({ language: 'es' });
  expect(line()?.textContent).toBe('Pagado. Vuelve al chat para verlo allí.');
  expect(links().map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Vuelve al chat', CHAT]]);

  // States without a return link keep their line, whatever chat the page knows.
  for (const state of ['issued', 'unknown'] as const) {
    update({ state, chatHref: CHAT });
    expect(links(), state).toHaveLength(0);
  }

  // Anything but a public chat's own path is ignored: the paid line as it was, with no link.
  for (const chatHref of ['', 'https://evil.example/d/rivera', '//evil.example', '/d/rivera?preview=desk-1', '/d/rivera#about', '/d/rivera/agents', '/d/Turner', 'javascript:alert(1)', '/pay/k7Hq2vX9']) {
    update({ state: 'paid', cancelReason: undefined, chatHref });
    expect(links(), chatHref).toHaveLength(0);
    expect(line()?.textContent, chatHref).toBe('Paid. Go back to the chat to see it there.');
  }
});
