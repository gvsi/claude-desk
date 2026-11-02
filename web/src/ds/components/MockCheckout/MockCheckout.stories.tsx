import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectDrawsShortArmFirst } from '../../test/expectDrawsShortArmFirst.ts';
import { MockCheckout } from './MockCheckout.tsx';

const BOARD = 'N-Checkout-Run2';

// The story list names a story `Error`, which shadows the global in this module, so the helpers
// below throw `globalThis.Error`.

/** The link the page reads (`PaymentLinkView`): the service call deposit. */
const link = rivera.paymentLinks.issued;

/** The page's amount string, as the screen makes it from the link's `amount_cents` (2000). */
const AMOUNT = '$20.00';

/**
 * The kernel's `customer_name` for Dana's verified session: first name and last initial. A link
 * carries it only while it is open, so only the open link's stories pass it.
 */
const CUSTOMER_NAME = 'Dana W.';

const meta = {
  title: 'Payments/MockCheckout',
  component: MockCheckout,
  args: {
    merchant: rivera.business.name,
    title: link.title,
    amount: AMOUNT,
    state: link.state,
    language: link.language,
    onPay: fn(),
    onCancel: fn(),
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'none',
    canvasNote: `From the owner-signed canvas board ${BOARD}, which draws the checkout in every state; the checkout stays outside the reference boards, checked against that board by its own stories. The heading is the link's own title (PaymentLinkView.title, "Service call deposit") and the amount its own line ("$20.00", with cents as the kernel prints amounts), where the board writes "Service call deposit, $20". Pay and Cancel are the design system's main buttons, 40 px tall, where the board draws 44 px.`,
  },
} satisfies Meta<typeof MockCheckout>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The checkout's fixed words that every state shows, by language. */
const CHROME = {
  en: {
    disclosure: 'This page is part of a chat with Claude, an AI.',
    badge: 'Test mode',
    footnote: 'Test payment, no money moves',
  },
  es: {
    disclosure: 'Esta página es parte de un chat con Claude, una IA.',
    badge: 'Modo de prueba',
    footnote: 'Pago de prueba, no se mueve dinero',
  },
} as const;

/** The checkout's parts, found by what they are. */
function partsOf(root: HTMLElement) {
  const page = root.querySelector<HTMLElement>('.cd-checkout');
  const disclosure = root.querySelector<HTMLElement>('.cd-disclosure-line');
  const card = root.querySelector<HTMLElement>('.cd-checkout__card');
  const footer = root.querySelector<HTMLElement>('[data-ds="concept-footer"]');
  if (!page || !disclosure || !card || !footer) throw new globalThis.Error('the checkout did not render its page, disclosure, card and footer');
  return { page, disclosure, card, footer };
}

function box(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

/**
 * What every state shows: the AI disclosure above the card and the concept footer below it, and
 * inside the card the merchant and the "Test mode" badge on its top line, the link's title, and
 * "Test payment, no money moves" closing it.
 */
async function expectChrome(root: HTMLElement, language: 'en' | 'es') {
  const words = CHROME[language];
  const { page, disclosure, card, footer } = partsOf(root);
  await expect(page).toHaveAttribute('lang', language);

  // checkout_discloses_ai: the line without the business's name, above the card, never hidden.
  await expect(disclosure.textContent).toBe(words.disclosure);
  await expect(disclosure).toBeVisible();
  await expect(box(disclosure).bottom).toBeLessThanOrEqual(box(card).top);
  await expect(box(footer).top).toBeGreaterThanOrEqual(box(card).bottom);

  // The card is named by its title, the link's own words.
  const title = within(card).getByRole('heading', { level: 1 });
  await expect(title.textContent).toBe(link.title);
  await expect(card).toHaveAccessibleName(link.title);
  const merchant = within(card).getByText(rivera.business.name);
  await expect(merchant).toHaveAttribute('data-copy', 'user');

  // test_payment_label_always_shown: the badge with its held dot at the card's top right, level
  // with the merchant at its top left, and the footnote as the card's last line.
  const badge = within(card).getByText(words.badge);
  await expect(badge).toHaveClass('cd-pill');
  await expect(badge.querySelector('.cd-status-dot--held')).not.toBeNull();
  const content = box(card);
  const padding = 24;
  await expect(box(badge).right).toBe(content.right - 1 - padding);
  await expect(box(merchant).left).toBe(content.left + 1 + padding);
  await expect(box(badge).top + box(badge).height / 2).toBeCloseTo(box(merchant).top + box(merchant).height / 2, 0);
  await expect(box(title).top).toBeGreaterThanOrEqual(box(badge).bottom);
  const footnote = within(card).getByText(words.footnote);
  await expect(card.lastElementChild).toBe(footnote);
  expectComputed(footnote, {
    fontSize: '12px',
    lineHeight: '17px',
    color: 'rgba(250, 249, 245, 0.64)',
    paddingTop: '12px',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.12)',
  });
  return { page, disclosure, card, footer, merchant, badge, title, footnote };
}

/** The read-only test card: its two labelled groups and the hint, in the page's language. */
const CARD_WORDS = {
  en: { information: 'Card information', name: 'Name on card', hint: 'Test card, filled in for you', pay: `Pay ${AMOUNT}`, cancel: 'Cancel payment' },
  es: { information: 'Datos de la tarjeta', name: 'Nombre en la tarjeta', hint: 'Tarjeta de prueba, ya rellenada', pay: `Pagar ${AMOUNT}`, cancel: 'Cancelar pago' },
} as const;

export const Issued: Story = {
  args: { customerName: CUSTOMER_NAME },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const { page, disclosure, card, footer, merchant, title, footnote } = await expectChrome(canvasElement, 'en');
    const words = CARD_WORDS.en;

    // The page: one column 420 px wide at most, centered, padded as the board's page, with the
    // disclosure, the card and the footer 14 px apart.
    expectComputed(page, { width: '420px', paddingTop: '28px', paddingLeft: '24px', paddingRight: '24px', paddingBottom: '20px' });
    await expect(box(page).left).toBe((window.innerWidth - 420) / 2);
    await expect(box(card).top - box(disclosure).bottom).toBe(14);
    await expect(box(footer).top - box(card).bottom).toBe(14);

    // The card: the board's quiet card, padded 24 px, its parts 14 px apart.
    expectComputed(card, {
      paddingTop: '24px',
      paddingLeft: '24px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
    });
    expectComputed(merchant, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(title, { fontSize: '15px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)', marginTop: '0px' });

    // The amount, large, exactly as the page gives it, with "This link works once." under it.
    const amount = within(card).getByText(AMOUNT);
    expectComputed(amount, { fontSize: '32px', lineHeight: '40px', fontWeight: '500', letterSpacing: '-0.3px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(box(amount).top - box(title).bottom).toBe(14);
    const once = within(card).getByText('This link works once.');
    expectComputed(once, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(box(once).top - box(amount).bottom).toBe(2);

    // The test card, filled in and locked: it is shown, never asked for. With the customer's name
    // from the link, nothing on the page takes input at all.
    await expect(canvasElement.querySelector('form, input, textarea, select, [contenteditable]')).toBeNull();
    const information = canvas.getByRole('group', { name: words.information });
    const label = within(information).getByText(words.information);
    expectComputed(label, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(box(label).top - box(once).bottom).toBe(14);
    const fields = information.querySelector<HTMLElement>('.cd-checkout__card-fields');
    if (!fields) throw new globalThis.Error('no card fields');
    expectComputed(fields, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.22)', borderTopLeftRadius: '8px' });
    await expect(box(fields).top - box(label).bottom).toBe(6);
    // Each value is read with its name: the number, the expiry and the security code.
    const values = [...fields.querySelectorAll<HTMLElement>('.cd-checkout__field')];
    await expect(values.map((field) => field.textContent)).toEqual([
      'Card number4242 4242 4242 4242',
      'Expiry date12 / 34',
      'Security code123',
    ]);
    // A description list holds only its terms and their values: each value's group is a dt and a
    // dd, with the number's lock inside its dd.
    for (const field of values) {
      await expect([...field.children].map((child) => child.tagName)).toEqual(['DT', 'DD']);
    }
    const [number, expiry, code] = values as [HTMLElement, HTMLElement, HTMLElement];
    for (const field of values) {
      expectComputed(field, { height: '40px', fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.64)', paddingLeft: '12px' });
    }
    // The number takes the whole row with a lock at its right; the expiry and the code share the
    // row under it, half each, split by the control line.
    const lock = number.querySelector('svg');
    await expect(lock).toHaveAttribute('aria-hidden', 'true');
    await expect(box(number).width).toBe(box(fields).width - 2);
    await expect(box(lock as SVGElement).right).toBe(box(number).right - 12);
    expectComputed(number, { borderBottomWidth: '1px', borderBottomColor: 'rgba(250, 249, 245, 0.22)' });
    await expect(box(expiry).top).toBe(box(number).bottom);
    await expect(box(code).top).toBe(box(expiry).top);
    await expect(box(code).width).toBeCloseTo(box(expiry).width, 0);
    expectComputed(code, { borderLeftWidth: '1px', borderLeftColor: 'rgba(250, 249, 245, 0.22)' });

    const name = canvas.getByRole('group', { name: words.name });
    const nameField = name.querySelector<HTMLElement>('.cd-checkout__field');
    if (!nameField) throw new globalThis.Error('no name field');
    await expect(box(name).top - box(fields).bottom).toBe(14);
    await expect(nameField.textContent).toBe(CUSTOMER_NAME);
    expectComputed(nameField, { height: '40px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.22)', borderTopLeftRadius: '8px' });
    const hint = within(name).getByText(words.hint);
    expectComputed(hint, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(hint.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(box(hint).top - box(nameField).bottom).toBe(6);

    // Pay with the page's amount, then Cancel: the main buttons, as wide as the card's content.
    const buttons = within(card).getAllByRole('button');
    await expect(buttons.map((button) => button.textContent)).toEqual([words.pay, words.cancel]);
    const [pay, cancel] = buttons as [HTMLElement, HTMLElement];
    await expect(pay).toHaveClass('cd-button--primary', 'cd-button--main');
    await expect(cancel).toHaveClass('cd-button--secondary', 'cd-button--main');
    await expect(box(pay).width).toBe(box(card).width - 2 - 48);
    await expect(box(cancel).width).toBe(box(pay).width);
    await expect(box(pay).top - box(hint).bottom).toBe(14);
    await expect(box(cancel).top - box(pay).bottom).toBe(8);
    await expect(box(footnote).top - box(cancel).bottom).toBe(14);

    // pays_once: two clicks in one go, before the page has drawn the first, pay once. Pay then
    // spins and Cancel waits in its busy colors, both still focusable and both inert, so no later
    // click pays or cancels either.
    pay.click();
    pay.click();
    await expect(args.onPay).toHaveBeenCalledTimes(1);
    await expect(pay).toHaveAttribute('aria-busy', 'true');
    await expect(pay).toHaveAttribute('aria-disabled', 'true');
    await expect(pay.querySelector('.cd-button__spinner')).not.toBeNull();
    await expect(cancel).toHaveClass('cd-button--waiting');
    await expect(cancel).toHaveAttribute('aria-disabled', 'true');
    await expect(cancel).not.toHaveAttribute('aria-busy');
    await expect(cancel.querySelector('.cd-button__spinner')).toBeNull();
    await userEvent.click(pay);
    await userEvent.click(cancel);
    await expect(args.onPay).toHaveBeenCalledTimes(1);
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};

/** The checkout's own English words, none of which a Spanish page shows. */
const ENGLISH_CHROME = [
  ...Object.values(CHROME.en),
  ...Object.values(CARD_WORDS.en),
  'This link works once.',
  'Card number',
  'Expiry date',
  'Security code',
];

export const IssuedEs: Story = {
  args: { language: 'es', customerName: CUSTOMER_NAME },
  parameters: {
    canvasNote: `${BOARD}'s "Issued, Spanish". The title is the link's own words, which stay as the owner wrote them; the board's Spanish title is a stand-in.`,
  },
  play: async ({ canvas, canvasElement }) => {
    const { card, footer } = await expectChrome(canvasElement, 'es');
    const words = CARD_WORDS.es;
    // The checkout's own words in Spanish: the line under the amount, the card's labels and the
    // names a screen reader gives its values, the hint and both buttons.
    await expect(within(card).getByText('Este enlace funciona una sola vez.')).toBeVisible();
    const information = canvas.getByRole('group', { name: words.information });
    await expect([...information.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Número de tarjeta',
      'Fecha de vencimiento',
      'Código de seguridad',
    ]);
    const name = canvas.getByRole('group', { name: words.name });
    await expect(within(name).getByText(words.hint)).toBeVisible();
    await expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual([words.pay, words.cancel]);
    // None of its English words, outside the owner's words and the concept footer, which stays
    // as it is on every surface.
    const own = [...canvasElement.querySelectorAll<HTMLElement>('.cd-checkout *')]
      .filter((el) => el.childElementCount === 0 && !el.closest('[data-copy="user"]') && !footer.contains(el))
      .map((el) => el.textContent ?? '')
      .join(' | ');
    for (const english of ENGLISH_CHROME) await expect(own).not.toContain(english);
  },
};

/** The line under the name to type, when the link carries no customer's name. */
const NAME_HINT = {
  en: 'Any name works. It stays on this page.',
  es: 'Cualquier nombre sirve. Se queda en esta página.',
} as const;

export const IssuedUnverified: Story = {
  parameters: {
    canvasNote: `${BOARD}'s "Issued" for a link from a session that hasn't verified, which the board doesn't draw: the link carries no customer's name, so "Name on card" is an empty field to type in, in the field outline every editable field has. Its own line says any name works and stays on the page, and the lock's "Test card, filled in for you" moves up under the card, so it doesn't sit under the one field the visitor fills.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expectChrome(canvasElement, 'en');
    // The name is the one thing to type, in a labelled field with no form around it.
    await expect(canvasElement.querySelector('form, textarea, select, [contenteditable]')).toBeNull();
    const field = canvas.getByRole('textbox', { name: 'Name on card' });
    await expect(canvasElement.querySelectorAll('input')).toHaveLength(1);
    await expect(field).toHaveValue('');
    await expect(field).not.toHaveAttribute('readonly');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    const label = canvasElement.querySelector(`label[for="${field.id}"]`) as HTMLElement;
    expectComputed(label, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(box(field).top - box(label).bottom).toBe(6);
    expectComputed(field, {
      height: '40px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.36)',
      borderTopLeftRadius: '8px',
      fontSize: '14px',
      color: 'rgba(250, 249, 245, 0.92)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
    });
    // The field the visitor fills says any name works and stays here, 6 px under it; that line
    // describes the field. The locked card's hint says the card is filled in, under the card, not
    // under the one field that isn't.
    const nameHint = canvas.getByText(NAME_HINT.en);
    await expect(box(nameHint).top - box(field).bottom).toBe(6);
    expectComputed(nameHint, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(nameHint.querySelector('svg')).toBeNull();
    await expect(field).toHaveAccessibleDescription(NAME_HINT.en);
    const information = canvas.getByRole('group', { name: CARD_WORDS.en.information });
    const fields = information.querySelector('.cd-checkout__card-fields') as HTMLElement;
    const hint = within(information).getByText(CARD_WORDS.en.hint);
    await expect(hint.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(box(hint).top - box(fields).bottom).toBe(6);
    await expect(box(label).top - box(hint).bottom).toBe(14);
    await expect(canvas.getAllByText(CARD_WORDS.en.hint)).toHaveLength(1);

    // typed_name_stays_on_the_page: Enter sends nothing, and Pay says only that it was pressed.
    await userEvent.type(field, 'Ana López{Enter}');
    await expect(field).toHaveValue('Ana López');
    await expect(args.onPay).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: CARD_WORDS.en.pay }));
    await expect(args.onPay).toHaveBeenCalledTimes(1);
    await expect(args.onPay).toHaveBeenCalledWith();
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};

export const Paying: Story = {
  args: { busy: true, customerName: CUSTOMER_NAME },
  parameters: {
    canvasNote: `${BOARD}'s "Paying": while the request is in flight only the pressed button spins, Pay when the screen says it is busy and nothing was pressed here, and Cancel waits in its busy colors.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expectChrome(canvasElement, 'en');
    const words = CARD_WORDS.en;
    const pay = canvas.getByRole('button', { name: words.pay });
    const cancel = canvas.getByRole('button', { name: words.cancel });
    // Pay keeps its words for a screen reader and its width, with the spinner in their place, a
    // step down to its busy fill; it stays focusable, says it is busy and does nothing.
    await expect(pay).toHaveTextContent(words.pay);
    await expect(pay).toHaveAttribute('aria-busy', 'true');
    await expect(pay).toHaveAttribute('aria-disabled', 'true');
    await expect(pay).toBeEnabled();
    await expect(pay.querySelector('.cd-button__spinner')).not.toBeNull();
    expectComputed(pay, { backgroundColor: 'rgb(221, 217, 207)' });
    // Cancel can't be pressed while the payment is in flight: its busy colors, no spinner.
    await expect(cancel).toHaveClass('cd-button--waiting');
    await expect(cancel).toHaveAttribute('aria-disabled', 'true');
    await expect(cancel).not.toHaveAttribute('aria-busy');
    await expect(cancel.querySelector('.cd-button__spinner')).toBeNull();
    expectComputed(cancel, { color: 'rgba(250, 249, 245, 0.64)' });
    await userEvent.click(pay);
    await userEvent.click(cancel);
    await expect(args.onPay).not.toHaveBeenCalled();
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};

/**
 * A final state: the merchant, the badge, the title and the footnote stay, the amount and the
 * test card go, and one line with its dot says what happened and where to go next. There is
 * nothing to press, so nothing can pay twice.
 */
async function expectFinal(root: HTMLElement, line: string, dot: 'handled' | 'held' | 'info') {
  const { card, title, footnote } = await expectChrome(root, 'en');
  // final_states_have_no_pay_button: no button of any kind, and none of the open link's parts.
  await expect(within(card).queryAllByRole('button')).toHaveLength(0);
  await expect(card.textContent).not.toContain(AMOUNT);
  await expect(within(card).queryByText('This link works once.')).toBeNull();
  await expect(within(card).queryByRole('group')).toBeNull();
  await expect(card.textContent).not.toContain('4242');

  const state = card.querySelector<HTMLElement>('.cd-checkout__state');
  if (!state) throw new globalThis.Error('no state line');
  await expect(state).toHaveTextContent(line, { normalizeWhitespace: true });
  await expect(state.textContent).toBe(line);
  await expect(state.querySelectorAll('.cd-status-dot')).toHaveLength(1);
  await expect(state.querySelector(`.cd-status-dot--${dot}`)).not.toBeNull();
  expectComputed(state, { fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.92)', marginTop: '0px' });
  // Under the title and over the footnote, 14 px from each, with the dot on its first line.
  await expect(box(state).top - box(title).bottom).toBe(14);
  await expect(box(footnote).top - box(state).bottom).toBe(14);
  const stateDot = state.querySelector('.cd-status-dot') as HTMLElement;
  const firstLine = box(state).top + 10;
  await expect(box(stateDot).top + box(stateDot).height / 2).toBe(firstLine);
  return { card, state };
}

export const Paid: Story = {
  args: { state: 'paid' },
  parameters: {
    canvasNote: `${BOARD}'s "Paid": the handled dot and the check that draws once beside the line, in the line's ink where the board draws it sage, since status color appears only as a dot.`,
  },
  play: async ({ canvasElement }) => {
    const { state } = await expectFinal(canvasElement, 'Paid. Go back to the chat to see it there.', 'handled');
    // The check is decorative and drawn once, in the line's own ink: status color stays on the
    // dot, and the words already say it was paid.
    const check = state.querySelector('svg');
    if (!check) throw new globalThis.Error('no check on the paid line');
    await expect(check).toHaveAttribute('aria-hidden', 'true');
    expectComputed(check, { color: 'rgba(250, 249, 245, 0.92)', width: '14px' });
    const stroke = check.querySelector('path') as SVGPathElement;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Under reduced motion the check doesn't move: it is drawn from the start.
      expectComputed(stroke, { animationName: 'none', strokeDashoffset: '0px' });
      return;
    }
    expectComputed(stroke, { animationName: /draw/, animationIterationCount: '1' });
    // It draws short arm first, as a hand writes a check.
    await expectDrawsShortArmFirst(stroke);
  },
};

/** The visitor's chat, as the page knows it from this browser: a public chat's own path. */
const CHAT_HREF = '/d/turner-plumbing';

export const PaidBackToTheChat: Story = {
  args: { state: 'paid', chatHref: CHAT_HREF },
  parameters: {
    canvasNote: `${BOARD}'s "Paid", as the #317 proposal boards (N-Nov1-317-After-1512 and its phone board) draw it when the page knows the visitor's chat: the same words, with "Go back to the chat" a text link in the sentence that opens the chat in the same tab.`,
  },
  play: async ({ canvasElement }) => {
    const { state } = await expectFinal(canvasElement, 'Paid. Go back to the chat to see it there.', 'handled');
    const links = state.querySelectorAll('a');
    await expect(links).toHaveLength(1);
    const back = links[0] as HTMLAnchorElement;
    await expect(back).toHaveTextContent('Go back to the chat');
    await expect(back).toHaveAttribute('href', CHAT_HREF);
    await expect(back).not.toHaveAttribute('target');
    // The design system's text link inside a sentence: accent blue, its quiet underline, and no
    // hit area beyond its words.
    await expect(back).toHaveClass('cd-text-link', 'cd-text-link--running-text');
    expectComputed(back, { color: 'rgb(126, 174, 218)', textDecorationLine: 'underline' });
    // The link sits on the line's first line, with the words before and after it.
    const words = state.querySelector('.cd-checkout__state-words');
    if (!words) throw new globalThis.Error('no words on the paid line');
    await expect(box(back).top).toBeGreaterThanOrEqual(box(words).top);
    await expect(box(back).bottom).toBeLessThanOrEqual(box(words).top + 20);
  },
};

export const Expired: Story = {
  args: { state: 'expired' },
  parameters: { canvasNote: `${BOARD}'s "Expired": the hollow info dot, and the chat as the place to go next.` },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, 'This payment link expired. Ask in the chat for a new one.', 'info');
  },
};

/** The line for a link the visitor or the chat cancelled. */
const CANCELLED_LINE = 'This payment was cancelled. Nothing was charged.';

export const Cancelled: Story = {
  args: { state: 'cancelled' },
  parameters: { canvasNote: `${BOARD}'s "Cancelled": the hollow info dot, and that nothing was charged.` },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, CANCELLED_LINE, 'info');
  },
};

export const CancelledBackToTheChat: Story = {
  args: { state: 'cancelled', chatHref: CHAT_HREF },
  parameters: {
    canvasNote: 'Cancelled for any reason but a rule change, with a known chat: keeps the cancelled sentence and appends the paid state’s same-tab return link. Copy and design await owner sign-off.',
  },
  play: async ({ canvasElement }) => {
    const { state } = await expectFinal(canvasElement, `${CANCELLED_LINE} Go back to the chat.`, 'info');
    const back = within(state).getByRole('link', { name: 'Go back to the chat' });
    await expect(state.querySelectorAll('a')).toHaveLength(1);
    await expect(back).toHaveAttribute('href', CHAT_HREF);
    await expect(back).not.toHaveAttribute('target');
    await expect(back).toHaveClass('cd-text-link', 'cd-text-link--running-text');
    expectComputed(back, { color: 'rgb(126, 174, 218)', textDecorationLine: 'underline' });
  },
};

export const CancelledBackToTheChatSpanish: Story = {
  args: { state: 'cancelled', chatHref: CHAT_HREF, language: 'es' },
  parameters: {
    canvasNote: 'Cancelled for any reason but a rule change, in Spanish: appends the paid state’s “Vuelve al chat” link. Copy and design await owner sign-off.',
  },
  play: async ({ canvasElement }) => {
    const { card } = await expectChrome(canvasElement, 'es');
    const state = card.querySelector<HTMLElement>('.cd-checkout__state');
    if (!state) throw new globalThis.Error('no cancelled line');
    await expect(state.textContent).toBe('Este pago se canceló. No se cobró nada. Vuelve al chat.');
    const back = within(state).getByRole('link', { name: 'Vuelve al chat' });
    await expect(back).toHaveAttribute('href', CHAT_HREF);
    await expect(back).not.toHaveAttribute('target');
    await expect(back).toHaveClass('cd-text-link', 'cd-text-link--running-text');
  },
};

export const CancelledRulesChanged: Story = {
  args: { state: 'cancelled', cancelReason: 'rules_changed' },
  parameters: {
    canvasNote: `${BOARD}'s "Cancelled because the rules changed", read from PaymentLinkView.cancel_reason.`,
  },
  play: async ({ canvasElement }) => {
    // rule_change_cancel_says_why: its own line, which says why and what to do, and never the
    // generic cancelled one.
    const { card } = await expectFinal(
      canvasElement,
      'This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay.',
      'info',
    );
    await expect(card.textContent).not.toContain(CANCELLED_LINE);
  },
};

export const Unknown: Story = {
  args: { state: 'unknown' },
  parameters: { canvasNote: `${BOARD}'s "Still being confirmed": the held dot, and the chat as where the result shows.` },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, 'This payment is still being confirmed. The chat will show the result.', 'held');
  },
};

export const Error: Story = {
  args: { error: true, customerName: CUSTOMER_NAME },
  parameters: {
    canvasNote: `${BOARD}'s "Error after paying": the error line under the buttons, which are back at rest, since the request is over.`,
  },
  play: async ({ canvas, canvasElement }) => {
    const { card, footnote } = await expectChrome(canvasElement, 'en');
    const words = CARD_WORDS.en;
    // error_says_to_reload: one alert, read out at once, that says what to do and never why.
    const alert = within(card).getByRole('alert');
    await expect(alert).toHaveTextContent('That didn’t go through. Reload this page to see where the payment stands.');
    await expect(alert.querySelector('.cd-status-dot--refused')).not.toBeNull();
    await expect(alert.textContent).not.toMatch(/\d{3}|error|invalid|conflict/i);
    // Under the buttons and over the footnote, 14 px from each.
    const pay = canvas.getByRole('button', { name: words.pay });
    const cancel = canvas.getByRole('button', { name: words.cancel });
    await expect(box(alert).top - box(cancel).bottom).toBe(14);
    await expect(box(footnote).top - box(alert).bottom).toBe(14);
    // The request is over, so both buttons are at rest again, as the board draws them.
    for (const button of [pay, cancel]) {
      await expect(button).not.toHaveAttribute('aria-busy');
      await expect(button).not.toHaveAttribute('aria-disabled');
    }
  },
};
