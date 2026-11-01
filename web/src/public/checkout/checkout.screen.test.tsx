/**
 * The mock checkout at `/pay/{token}` in a real browser against the mock API: the page a visitor
 * opens from a payment link card, with the AI disclosure and the test-payment label in every
 * state, the amount from the kernel's cents, one payment at most, and the chat told what happened.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { SseEvent } from '../../api/contracts.ts';
import type { PaymentLinkOut } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { payChatKey, recordPayChat } from '../../lib/payChats.ts';
import { LINK_CANCELLED, type Language } from '../../mocks/script.ts';
import { BUSINESS, RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const CHAT = `/d/${RIVERA.slug}`;

/** This browser's record of each payment link's chat, as `storage.ts` keeps it. */
const PAY_CHATS = 'claude-desk.pay-chats';

/** Every event this browser's chat with Turner has carried, in order. */
function chatEvents(): { seq: number; ev: SseEvent }[] {
  return mockStore.visitorSession(RIVERA.slug)?.events ?? [];
}

/** The messages the chat has carried from the Desk itself (author `desk`). */
const deskMessages = () => chatEvents().filter(({ ev }) => ev.type === 'message' && ev.author === 'desk');

/** Waits for the chat to load: its composer can be typed in. */
async function ready(screen: RenderResult): Promise<void> {
  await expect.element(screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / })).toBeEnabled();
}

/**
 * Asks Turner's chat for the deposit and waits for the payment link card: the token its button
 * opens. The link belongs to this browser's chat.
 */
async function linkFromTheChat(): Promise<string> {
  const { screen } = await renderRoute(CHAT);
  await ready(screen);
  await screen.getByRole('textbox', { name: 'Message Turner Plumbing' }).fill('How do I pay the deposit?');
  await screen.getByRole('button', { name: 'Send' }).click();
  const open = screen.getByRole('link', { name: 'Open payment page' });
  await expect.element(open).toBeVisible();
  const token = /^\/pay\/([A-Za-z0-9_-]+)$/.exec(open.element().getAttribute('href') ?? '')?.[1];
  if (token === undefined) throw new Error('the payment link card opens /pay/{token}');
  return token;
}

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** A payment link for a new chat with Turner's Desk: its token. */
function issueLink(language: Language = 'en', amountCents = 2000): string {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId);
  if (!desk) throw new Error("the copy has Turner's main Desk");
  const session = world.addSession(desk);
  return world.issueLink(session, { title: language === 'es' ? 'Depósito de visita de servicio' : 'Service call deposit', amountCents, language });
}

/** Pays the link as another tab would, while the page shows it. */
function payBehindThePage(token: string): void {
  const link = mockStore.world.links.get(token);
  if (!link) throw new Error(`no payment link ${token}`);
  mockStore.world.payLink(token, link);
}

/** Cancels the link as the kernel does when the owner confirms rules that no longer allow it. */
function cancelForRuleChange(token: string): void {
  const link = mockStore.world.links.get(token);
  if (!link) throw new Error(`no payment link ${token}`);
  mockStore.world.cancelLink(token, link, 'rules_changed');
}

describe('mock checkout', () => {
  it('checkout_discloses_ai_and_test_payment', async () => {
    const en = await renderRoute(`/pay/${issueLink('en')}`);
    await expect.element(en.screen.getByRole('heading', { name: 'Service call deposit' })).toBeVisible();
    await expect.element(en.screen.getByText('This page is part of a chat with Claude, an AI.')).toBeVisible();
    await expect.element(en.screen.getByText('Test mode')).toBeVisible();
    await expect.element(en.screen.getByText('Test payment, no money moves')).toBeVisible();
    await expect.element(en.screen.getByText('Turner Plumbing')).toBeVisible();
    await expectScreenBasics(en.screen.container, { owner: false });

    // The page follows the link's language, whatever the browser's.
    const es = await renderRoute(`/pay/${issueLink('es')}`, { language: 'en-US' });
    await expect.element(es.screen.getByRole('heading', { name: 'Depósito de visita de servicio' })).toBeVisible();
    await expect.element(es.screen.getByText('Esta página es parte de un chat con Claude, una IA.')).toBeVisible();
    await expect.element(es.screen.getByText('Modo de prueba')).toBeVisible();
    await expect.element(es.screen.getByText('Pago de prueba, no se mueve dinero')).toBeVisible();
    await expectScreenBasics(es.screen.container, { owner: false });

    // At phone width it fits, with nothing scrolling sideways.
    const phone = await renderRoute(`/pay/${issueLink('en')}`, { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('checkout_names_the_tab', async () => {
    // What the payment is for, as the card's title says it, then the business as the card names it.
    document.title = 'Claude Desk';
    const en = await renderRoute(`/pay/${issueLink('en')}`);
    await expect.element(en.screen.getByRole('heading', { name: 'Service call deposit' })).toBeVisible();
    expect(document.title).toBe('Service call deposit · Turner Plumbing');
    const es = await renderRoute(`/pay/${issueLink('es')}`, { language: 'en-US' });
    await expect.element(es.screen.getByRole('heading', { name: 'Depósito de visita de servicio' })).toBeVisible();
    expect(document.title).toBe('Depósito de visita de servicio · Turner Plumbing');

    // Without the business's name, the payment's alone; before a link shows, the app's own name.
    const token = issueLink('en');
    const asTheApiSendsIt: Omit<PaymentLinkOut, 'business_name' | 'customer_name'> = { title: 'Service call deposit', amount_cents: 2000, state: 'issued', language: 'en' };
    mockStore.inject({ route: 'paymentLink', status: 200, times: 1, body: asTheApiSendsIt });
    const unnamed = await renderRoute(`/pay/${token}`);
    await expect.element(unnamed.screen.getByRole('heading', { name: 'Service call deposit' })).toBeVisible();
    expect(document.title).toBe('Service call deposit');
    const missing = await renderRoute('/pay/no-such-link');
    await expect.element(missing.screen.getByText("This payment link doesn't exist. Ask in the chat for a new one.", { exact: true })).toBeVisible();
    expect(document.title).toBe('Claude Desk');
  });

  it('checkout_document_language_follows_the_page', async () => {
    // The document's language, as index.html sets it (the test browser's page has its own).
    document.documentElement.lang = 'en';
    // A link in Spanish: the whole document is Spanish while the checkout shows it, whatever the browser's language.
    const es = await renderRoute(`/pay/${issueLink('es')}`, { language: 'en-US' });
    await expect.element(es.screen.getByRole('heading', { name: 'Depósito de visita de servicio' })).toBeVisible();
    expect(document.documentElement.lang).toBe('es');
    // Leaving the page hands the document its language back.
    await es.router.navigate('/no/such/page');
    await expect.element(es.screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(document.documentElement.lang).toBe('en');

    // A link in English from a Spanish browser: English once the link shows.
    const en = await renderRoute(`/pay/${issueLink('en')}`, { language: 'es-MX' });
    await expect.element(en.screen.getByRole('heading', { name: 'Service call deposit' })).toBeVisible();
    expect(document.documentElement.lang).toBe('en');

    // Before a link shows, the page is in the browser's language, and so is the document.
    const missing = await renderRoute('/pay/n0SuchL1nk', { language: 'es-MX' });
    await expect.element(missing.screen.getByText('Este enlace de pago no existe. Pide uno nuevo en el chat.')).toBeVisible();
    expect(document.documentElement.lang).toBe('es');
  });

  it('checkout_amount_from_cents', async () => {
    // The kernel's cents, written with their cents as a payment page does: never a figure of the page's own.
    const { screen } = await renderRoute(`/pay/${issueLink('en', 2000)}`);
    await expect.element(screen.getByText('$20.00', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();

    const odd = await renderRoute(`/pay/${issueLink('es', 4050)}`);
    await expect.element(odd.screen.getByText('$40.50', { exact: true })).toBeVisible();
    await expect.element(odd.screen.getByRole('button', { name: 'Pagar $40.50' })).toBeVisible();
    expect(requests('paymentLink')).toHaveLength(2);
  });

  it('checkout_names_the_business_and_customer', async () => {
    // A link from Dana's chat once she confirmed it's her: the business at the card's top, and her
    // name on the test card as the kernel gives it, read-only.
    const { world } = mockStore;
    const desk = world.desk(RIVERA.deskId);
    if (!desk) throw new Error("the copy has Turner's main Desk");
    const danasChat = world.addSession(desk);
    world.verify(danasChat, rivera.people.dana);
    const named = world.issueLink(danasChat, { title: 'Service call deposit', amountCents: 2000, language: 'en' });
    const { screen } = await renderRoute(`/pay/${named}`);
    const merchant = screen.getByText('Turner Plumbing', { exact: true });
    await expect.element(merchant).toBeVisible();
    expect(merchant.element().closest('.cd-checkout__top')).not.toBeNull();
    await expect.element(screen.getByRole('group', { name: 'Name on card' }).getByText('Dana W.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Name on card' })).not.toBeInTheDocument();

    // A link from a chat with no one on record: an empty name field to fill in, and what is typed
    // there never leaves the page, not with the payment and not in any other request.
    const fetches = vi.spyOn(window, 'fetch');
    const open = await renderRoute(`/pay/${issueLink()}`);
    const field = open.screen.getByRole('textbox', { name: 'Name on card' });
    await expect.element(field).toHaveValue('');
    await field.fill('Sam Ortiz');
    await expect.element(field).toHaveValue('Sam Ortiz');
    await open.screen.getByRole('button', { name: 'Pay $20.00' }).click();
    await expect.element(open.screen.getByText('Paid. Go back to the chat to see it there.')).toBeVisible();
    const paid = requests('completePayment');
    expect(paid).toHaveLength(1);
    expect(JSON.stringify(paid[0]?.body ?? null)).not.toMatch(/name|Sam Ortiz/i);
    for (const request of mockStore.requests) expect(JSON.stringify(request)).not.toContain('Sam Ortiz');
    expect(fetches).toHaveBeenCalled();
    for (const call of fetches.mock.calls) expect(JSON.stringify(call)).not.toContain('Sam Ortiz');
    fetches.mockRestore();
  });

  it('checkout_leaves_out_a_missing_business_name', async () => {
    // The kernel's view names the business, but a view without the name (as the API sent before
    // the kernel payments plan, plan 01c) still works: the checkout leaves the name out.
    const token = issueLink('en', 2000);
    const withoutTheName: Omit<PaymentLinkOut, 'business_name' | 'customer_name'> = { title: 'Service call deposit', amount_cents: 2000, state: 'issued', language: 'en' };
    mockStore.inject({ route: 'paymentLink', status: 200, times: 10_000, body: withoutTheName });
    const { screen } = await renderRoute(`/pay/${token}`);
    await expect.element(screen.getByRole('heading', { name: 'Service call deposit' })).toBeVisible();
    await expect.element(screen.getByText('This page is part of a chat with Claude, an AI.')).toBeVisible();
    await expect.element(screen.getByText('$20.00', { exact: true })).toBeVisible();
    const card = screen.getByRole('group', { name: 'Card information' });
    await expect.element(card.getByText('4242 4242 4242 4242', { exact: true })).toBeVisible();
    await expect.element(card.getByText('12 / 34', { exact: true })).toBeVisible();
    await expect.element(card.getByText('123', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Name on card' })).toBeVisible();
    await expect.element(screen.getByText('Test mode')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();
    expect(screen.container.querySelectorAll('[role="alert"]')).toHaveLength(0);

    // No merchant line: the design system's checkout keeps the merchant's place at the card's top,
    // and with no name it holds no text and takes no room, so the top is just the badge's row.
    const top = screen.container.querySelector('.cd-checkout__top');
    const badge = top?.querySelector('.cd-pill');
    if (!top || !badge) throw new Error("the card's top holds the Test mode badge");
    const merchant = top.querySelector('.cd-checkout__merchant');
    if (merchant !== null) {
      expect(merchant.textContent).toBe('');
      const { width, height } = merchant.getBoundingClientRect();
      expect({ width, height }).toEqual({ width: 0, height: 0 });
    }
    expect(top.getBoundingClientRect().height).toBe(badge.getBoundingClientRect().height);

    // The page names no business of its own: not the mock's, not the Desk's, not a placeholder.
    const desk = mockStore.world.desk(RIVERA.deskId);
    if (!desk) throw new Error("the copy has Turner's main Desk");
    const shown = screen.container.textContent ?? '';
    expect(shown).not.toContain(BUSINESS.name);
    expect(shown).not.toContain(desk.summary.name);
    expect(shown).not.toMatch(/\b(?:undefined|null)\b/);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('checkout_pays_once', async () => {
    const token = await linkFromTheChat();
    const { screen } = await renderRoute(`/pay/${token}`);
    const pay = screen.getByRole('button', { name: 'Pay $20.00' });
    await expect.element(pay).toBeVisible();
    // Two clicks in a row, the second before the page has drawn the first.
    const button = pay.element() as HTMLElement;
    button.click();
    button.click();
    await expect.element(screen.getByText('Paid. Go back to the chat to see it there.')).toBeVisible();
    expect(requests('completePayment')).toHaveLength(1);
    // Paid: no amount, no card and no buttons to press again.
    expect(screen.container.querySelectorAll('button')).toHaveLength(0);

    // The chat shows the kernel's payment_confirmed card once, from the Desk.
    expect(deskMessages()).toHaveLength(1);
    const chat = await renderRoute(CHAT);
    await ready(chat.screen);
    const paid = chat.screen.getByRole('article', { name: 'Paid' });
    await expect.element(paid).toBeVisible();
    expect(paid.elements()).toHaveLength(1);
  });

  it('paid_link_shows_final_state', async () => {
    // A link already paid opens on its line, with nothing to pay or cancel.
    const done = issueLink();
    payBehindThePage(done);
    const { screen } = await renderRoute(`/pay/${done}`);
    await expect.element(screen.getByText('Paid. Go back to the chat to see it there.')).toBeVisible();
    expect(screen.container.querySelectorAll('button')).toHaveLength(0);
    await expect.element(screen.getByText('$20.00', { exact: true })).not.toBeInTheDocument();
    await expectScreenBasics(screen.container, { owner: false });

    // Paid in another tab while this one was open: the refusal's state shows, not an error.
    const other = issueLink();
    const open = await renderRoute(`/pay/${other}`);
    const pay = open.screen.getByRole('button', { name: 'Pay $20.00' });
    await expect.element(pay).toBeVisible();
    payBehindThePage(other);
    await pay.click();
    await expect.element(open.screen.getByText('Paid. Go back to the chat to see it there.')).toBeVisible();
    await expect.element(open.screen.getByText('That didn’t go through. Reload this page to see where the payment stands.')).not.toBeInTheDocument();
    expect(open.screen.container.querySelectorAll('button')).toHaveLength(0);
  });

  it('paid_line_links_back_to_the_chat', async () => {
    // The chat showed the link's card, so this browser knows the chat it came from: once paid, the
    // line's own words "Go back to the chat" lead there.
    const token = await linkFromTheChat();
    const { screen } = await renderRoute(`/pay/${token}`);
    await screen.getByRole('button', { name: 'Pay $20.00' }).click();
    const back = screen.getByRole('link', { name: 'Go back to the chat', exact: true });
    await expect.element(back).toBeVisible();
    expect(back.element().getAttribute('href')).toBe(CHAT);
    // Today's words, unchanged, with the link inside the line.
    const line = screen.container.querySelector('.cd-checkout__state');
    expect(line?.textContent).toBe('Paid. Go back to the chat to see it there.');
    expect(back.element().closest('.cd-checkout__state')).toBe(line);
    expect(screen.container.querySelectorAll('a')).toHaveLength(1);

    // It opens the chat in this tab: no new tab, and a plain click is left to the browser to
    // follow (the test stops it there, so this page stays loaded).
    expect(back.element().getAttribute('target')).toBeNull();
    let followed: boolean | null = null;
    const stop = (event: MouseEvent) => {
      followed = !event.defaultPrevented;
      event.preventDefault();
    };
    window.addEventListener('click', stop);
    try {
      await back.click();
    } finally {
      window.removeEventListener('click', stop);
    }
    expect(followed).toBe(true);
    await expectScreenBasics(screen.container, { owner: false });

    // At phone width the line fits with its link, with nothing scrolling sideways.
    const phone = await renderRoute(`/pay/${token}`, { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('link', { name: 'Go back to the chat', exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('paid_line_links_back_in_spanish', async () => {
    // A link in Spanish, from a chat this browser showed: "Vuelve al chat" is the link, whatever
    // the browser's language.
    const token = issueLink('es');
    recordPayChat(token, CHAT);
    const { screen } = await renderRoute(`/pay/${token}`, { language: 'en-US' });
    await screen.getByRole('button', { name: 'Pagar $20.00' }).click();
    const back = screen.getByRole('link', { name: 'Vuelve al chat', exact: true });
    await expect.element(back).toBeVisible();
    expect(back.element().getAttribute('href')).toBe(CHAT);
    expect(back.element().getAttribute('target')).toBeNull();
    expect(screen.container.querySelector('.cd-checkout__state')?.textContent).toBe('Pagado. Vuelve al chat para verlo allí.');
    expect(back.element().closest('[lang]')?.getAttribute('lang')).toBe('es');
    await expectScreenBasics(screen.container, { owner: false });

    // Without a known chat, the Spanish line as it was, with no link.
    const unknown = await renderRoute(`/pay/${issueLink('es')}`, { language: 'en-US' });
    await unknown.screen.getByRole('button', { name: 'Pagar $20.00' }).click();
    await expect.element(unknown.screen.getByText('Pagado. Vuelve al chat para verlo allí.', { exact: true })).toBeVisible();
    expect(unknown.screen.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('paid_line_without_a_known_chat_has_no_link', async () => {
    const PAID = 'Paid. Go back to the chat to see it there.';
    /** Pays `token` on its checkout and returns the paid line, after checking it has no link. */
    async function paidWithoutALink(token: string, why: string): Promise<void> {
      const { screen } = await renderRoute(`/pay/${token}`);
      await screen.getByRole('button', { name: 'Pay $20.00' }).click();
      await expect.element(screen.getByText(PAID, { exact: true })).toBeVisible();
      expect(screen.container.querySelector('.cd-checkout__state')?.textContent, why).toBe(PAID);
      expect(screen.container.querySelectorAll('a'), why).toHaveLength(0);
    }

    // No chat showed this link in this browser: today's line, with no link.
    await paidWithoutALink(issueLink(), 'nothing recorded');

    // Another link's chat is known, not this one's.
    recordPayChat(issueLink(), CHAT);
    await paidWithoutALink(issueLink(), "another token's entry");

    // A record for this link that holds anything but a public chat's own path.
    for (const path of ['https://evil.example/d/rivera', '//evil.example', `${CHAT}?preview=${RIVERA.deskId}`, `${CHAT}/agents`, '/D/Turner', 'javascript:alert(1)']) {
      const token = issueLink();
      localStorage.setItem(PAY_CHATS, JSON.stringify([[payChatKey(token), path]]));
      await paidWithoutALink(token, path);
    }

    // Storage that can't be read: the line as it was.
    const token = issueLink();
    recordPayChat(token, CHAT);
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked.', 'SecurityError');
    });
    try {
      await paidWithoutALink(token, 'storage blocked');
    } finally {
      blocked.mockRestore();
    }
  });

  it('unknown_link_is_kind', async () => {
    // No link has this token: a plain line in the browser's language, with the way forward.
    const { screen } = await renderRoute('/pay/n0SuchL1nk');
    await expect.element(screen.getByText("This payment link doesn't exist. Ask in the chat for a new one.")).toBeVisible();
    await expect.element(screen.getByText('This page is part of a chat with Claude, an AI.')).toBeVisible();
    expect(screen.container.querySelectorAll('button')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });

    const es = await renderRoute('/pay/n0SuchL1nk', { language: 'es-MX' });
    await expect.element(es.screen.getByText('Este enlace de pago no existe. Pide uno nuevo en el chat.')).toBeVisible();
    await expect.element(es.screen.getByText('Esta página es parte de un chat con Claude, una IA.')).toBeVisible();
    await expectScreenBasics(es.screen.container, { owner: false });
    expect(requests('paymentLink').map((r) => r.path)).toEqual(['/api/pay/n0SuchL1nk', '/api/pay/n0SuchL1nk']);
  });

  it('checkout_names_a_rule_change', async () => {
    const RULES_CHANGED = 'This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay.';
    const CANCELLED = 'This payment was cancelled. Nothing was charged.';

    // The owner confirmed rules that no longer allow the chat's open link, so the kernel cancelled it.
    const token = await linkFromTheChat();
    cancelForRuleChange(token);
    const { screen } = await renderRoute(`/pay/${token}`);
    await expect.element(screen.getByText(RULES_CHANGED)).toBeVisible();
    await expect.element(screen.getByText(CANCELLED)).not.toBeInTheDocument();
    expect(screen.container.querySelectorAll('button')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });

    // Cancelled while the page was open: Pay is refused with the link's state and why.
    const other = issueLink();
    const open = await renderRoute(`/pay/${other}`);
    const pay = open.screen.getByRole('button', { name: 'Pay $20.00' });
    await expect.element(pay).toBeVisible();
    cancelForRuleChange(other);
    await pay.click();
    await expect.element(open.screen.getByText(RULES_CHANGED)).toBeVisible();
    await expect.element(open.screen.getByText(CANCELLED)).not.toBeInTheDocument();
    expect(requests('completePayment')).toHaveLength(1);

    // The chat shows the kernel's link_cancelled card once, from the Desk, as its reply card: the
    // label beside the payment link's icon, the link's amount as the headline, then what the link
    // was for and the kernel's line, with no link, button or test-payment note.
    expect(deskMessages()).toHaveLength(1);
    const chat = await renderRoute(CHAT);
    await ready(chat.screen);
    const line = chat.screen.getByText(LINK_CANCELLED.en);
    await expect.element(line).toBeVisible();
    expect(line.elements()).toHaveLength(1);
    const card = chat.screen.getByRole('article', { name: 'Payment link cancelled' });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).toBe(`Payment link cancelled$20.00Service call deposit${LINK_CANCELLED.en}`);
    expect(card.element().querySelector('.cd-reply-card__headline')?.textContent).toBe('$20.00');
    expect([...card.element().querySelectorAll('.cd-reply-card__detail')].map((detail) => detail.textContent)).toEqual([
      'Service call deposit',
      LINK_CANCELLED.en,
    ]);
    const icon = card.element().querySelector('.cd-reply-card__label svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect([...(icon?.querySelectorAll('rect, path') ?? [])].map((shape) => shape.tagName)).toEqual(['rect', 'path']);
    expect(card.element().querySelectorAll('a, button')).toHaveLength(0);
    expect(card.element().textContent).not.toContain('Test payment');
    // Its only receipt is the reply check's own line, which a stranger's chat leaves out (the
    // owner's decision of 2026-10-31); the owner's preview and transcript keep it.
    const row = card.element().closest('.cd-transcript-row');
    expect(row?.querySelector('.cd-margin-receipt')).toBeNull();
    await expectScreenBasics(chat.screen.container, { owner: false });
  });
});
