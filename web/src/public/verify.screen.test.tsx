/**
 * Demo-code verification and the Demo inbox in a real browser against the mock API: the code form
 * under the kernel's verify card, the code going only to the verify route, one line for every
 * failed code, the simulated label once it works, and the inbox each side reads.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { SseEvent } from '../api/contracts.ts';
import { request } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { CHAT_ENDED_COPY, NEW_CHAT_LABEL, UNREACHABLE_COPY } from '../ds/index.ts';
import { DEMO_CODE } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { liveSetupDesk } from '../test/liveSetupDesk.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { aPollPasses, closedInboxReads, expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const PAGE = `/d/${RIVERA.slug}`;

/** The chat's line once a demo code works, with the design system's simulated label. */
const VERIFIED = 'Verified with a code. Simulated verification';

/** The form's one line for a code that didn't work, whatever the reason. */
const FAILED = 'That code didn’t work. Check the newest code, or ask me for a new one.';

/** What the Demo inbox entry for the invoice row's code says, word for word: the kernel's `inbox_code_body`. */
const CODE_BODY = `Your Turner Plumbing code is ${DEMO_CODE}. It expires in ten minutes. If you didn't ask for it, ignore this message.`;

/** The inbox's place when it couldn't be read at all, so no entry can say it failed. */
const INBOX_FAILED = 'Couldn’t open the Demo inbox, where your code arrives.';

/** What the visitor's Demo inbox stands for, under its title. */
const VISITOR_SUBTITLE = 'Stands in for a phone or email inbox. Nothing is really sent.';

/** What the owner's notifications stand for, under their page's title. */
const OWNER_SUBTITLE = 'What Claude would have sent you and your customers by text or email. Nothing is really sent.';

/** The owner's line for a read the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';

/** Claude's checked line before the verify card, as the signed verify board writes it. */
const VERIFY_FIRST = "I can send that after you confirm it's you.";

/** The kernel's verify card, as the script's invoice row sends it. */
const VERIFY_CARD = rivera.blocks.verify_prompt.en.title ?? '';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Every event this browser's chat with Turner has carried, in order. */
function chatEvents(): { seq: number; ev: SseEvent }[] {
  return mockStore.visitorSession(RIVERA.slug)?.events ?? [];
}

/** Waits for the chat to load: its composer can be typed in. */
async function ready(screen: RenderResult): Promise<void> {
  await expect.element(screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / })).toBeEnabled();
}

/** Types `text` and sends it, then waits for the turn to end. */
async function say(screen: RenderResult, text: string): Promise<void> {
  const before = chatEvents().length;
  await screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / }).fill(text);
  await screen.getByRole('button', { name: /^(?:Send|Enviar)$/ }).click();
  await vi.waitFor(
    () => {
      const events = chatEvents();
      expect(events.length).toBeGreaterThan(before);
      expect(events.at(-1)?.ev.type).toBe('turn_end');
    },
    { timeout: 5_000 },
  );
}

/**
 * Pastes `text` into the code field as a visitor does: copied with the keyboard from elsewhere on
 * the page, then pasted into the field with the keyboard.
 */
async function pasteInto(field: HTMLInputElement, text: string): Promise<void> {
  const source = document.createElement('input');
  source.value = text;
  document.body.append(source);
  source.focus();
  source.select();
  await userEvent.copy();
  source.remove();
  field.focus();
  await userEvent.paste();
}

describe('verification', () => {
  it('verify_prompt_shows_the_code_form', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const card = screen.getByRole('article', { name: "Confirm it's you" });
    await expect.element(card).toBeVisible();
    // The form under it says nothing of the kernel's message: its words show once, on the card.
    await expect.element(screen.getByRole('textbox', { name: '6-digit code' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await expect.element(screen.getByRole('button', { name: 'I can’t get the code' })).toBeVisible();
    expect(screen.getByText(VERIFY_CARD).elements()).toHaveLength(1);
    // Claude's own line comes first in the same message, then the card, as the board draws them.
    const row = card.element().closest('.cd-transcript-row');
    const said = screen.getByText(VERIFY_FIRST, { exact: true });
    await expect.element(said).toBeVisible();
    expect(row?.contains(said.element())).toBe(true);
    expect(said.element().compareDocumentPosition(card.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The form sits with the message that asked for the code, under its receipts.
    expect(row?.querySelector('.cd-transcript-row__margin input[autocomplete="one-time-code"]')).not.toBeNull();
    const receipts = [...(row?.querySelectorAll('.cd-transcript-row__margin .cd-margin-receipt') ?? [])].map((el) => el.textContent?.trim());
    expect(receipts).toEqual(['Verification started']);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('cant_get_the_code_closes_the_form_while_the_owner_is_in_the_chat', async () => {
    const ask = "I'd like to talk to Mike Turner.";
    const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const escape = screen.getByRole('button', { name: 'I can’t get the code' });
    await expect.element(escape).toBeVisible();

    // Mike takes the chat over. He is already here, so the form's way out asks for nobody: it
    // closes the form, sends nothing, and focus moves on to the composer. The kernel's card stays.
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('this browser has a chat');
    mockStore.world.takeOver(chat);
    await vi.waitFor(() => expect(document.querySelector('.cd-public-shell__disclosure')?.textContent).toMatch(/^Mike Turner is in this chat\./));
    const sent = requests('sendMessage').length;
    await escape.click();
    await expect.element(screen.getByRole('textbox', { name: '6-digit code' })).not.toBeInTheDocument();
    await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toHaveFocus();
    expect(screen.getByText(ask, { exact: true }).query()).toBeNull();
    expect(requests('sendMessage')).toHaveLength(sent);
    await expect.element(screen.getByRole('article', { name: "Confirm it's you" })).toBeVisible();

    // He hands the chat back: the form comes back under the card, its way out with it.
    mockStore.world.handBack(chat);
    await expect.element(screen.getByRole('textbox', { name: '6-digit code' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'I can’t get the code' })).toBeVisible();

    // With Claude answering, the same button asks for him, as the head's Ask does.
    const again = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(again.screen);
    await say(again.screen, 'Can you send my invoice?');
    await again.screen.getByRole('button', { name: 'I can’t get the code' }).click();
    await expect.element(again.screen.getByText(ask, { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(requests('sendMessage').map((r) => r.body)).toContainEqual({ text: ask }));
  });

  it('cant_get_the_code_asks_for_a_person_when_the_owner_gave_no_name', async () => {
    // A Desk whose owner gave no name in setup: the form's way out asks for a person, as the head's
    // Ask does, in the visitor's language, and never for "Owner".
    const slug = await liveSetupDesk('Fenster & Fenster. Bespoke windows and doors in Oakland.');
    const asks = { en: "I'd like to talk to a person.", es: 'Quiero hablar con una persona.' };
    for (const [language, browser, invoice, cantGetCode] of [
      ['en', 'en-US', 'Can you send my invoice?', 'I can’t get the code'],
      ['es', 'es-MX', 'Necesito mi factura', 'No me llega el código'],
    ] as const) {
      const { screen } = await renderRoute(`/d/${slug}`, { language: browser });
      await ready(screen);
      const before = mockStore.visitorSession(slug)?.events.length ?? 0;
      await screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / }).fill(invoice);
      await screen.getByRole('button', { name: /^(?:Send|Enviar)$/ }).click();
      await vi.waitFor(() => expect(mockStore.visitorSession(slug)?.events.slice(before).at(-1)?.ev.type).toBe('turn_end'), { timeout: 5_000 });
      await screen.getByRole('button', { name: cantGetCode }).click();
      await expect.element(screen.getByText(asks[language], { exact: true })).toBeVisible();
      await vi.waitFor(() => expect(requests('sendMessage').at(-1)?.body).toEqual({ text: asks[language] }));
    }
    expect(requests('sendMessage').map((r) => JSON.stringify(r.body)).join(' ')).not.toMatch(/Owner|null/);
  });

  it('a_late_verify_answer_never_brings_the_owner_back', async () => {
    const ownerLine = /^Mike Turner is in this chat\./;
    const headLine = () => document.querySelector('.cd-public-shell__disclosure')?.textContent ?? '';
    /** The head's lines from now on, until `stop`. */
    const watchHead = () => {
      const seen = new Set<string>([headLine()]);
      const watch = new MutationObserver(() => seen.add(headLine()));
      watch.observe(document.body, { childList: true, subtree: true, characterData: true });
      onTestFinished(() => watch.disconnect());
      return { seen: () => [...seen], stop: () => watch.disconnect() };
    };
    /** A request held until the test lets it land. */
    const held = () => {
      let release = () => {};
      const until = new Promise<void>((resolve) => (release = resolve));
      onTestFinished(() => release());
      return { until, release };
    };

    for (const answer of ['the verify answer', 'the read after a lost verify answer'] as const) {
      // Dana asks for her invoice, and Mike takes the chat over while the form is up.
      const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
      await ready(screen);
      await say(screen, 'Can you send my invoice?');
      const chat = mockStore.visitorSession(RIVERA.slug);
      if (!chat) throw new Error('this browser has a chat');
      mockStore.world.takeOver(chat);
      await vi.waitFor(() => expect(headLine()).toMatch(ownerLine));

      // Dana sends the code. Its answer (or, when that is lost, the read of the session after it)
      // was taken while the chat was in Mike's hands, and lands only after he has handed it back
      // and Claude has started writing.
      const late = held();
      if (answer === 'the verify answer') {
        mockStore.inject({ route: 'verifyCheck', status: 200, afterCommit: true, until: late.until, body: { state: { ...chat.state, verified: true, assurance: 'demo_code' } } });
      } else {
        const read = await request('visitorSession', { params: { slug: RIVERA.slug } });
        mockStore.inject({ route: 'verifyCheck', status: 'network', afterCommit: true });
        mockStore.inject({ route: 'visitorSession', status: 200, until: late.until, body: { ...read, state: { ...read.state, verified: true, assurance: 'demo_code' } } });
      }
      const route = answer === 'the verify answer' ? 'verifyCheck' : 'visitorSession';
      const asked = requests(route).length;
      await screen.getByRole('textbox', { name: '6-digit code' }).fill(DEMO_CODE);
      await screen.getByRole('button', { name: 'Confirm' }).click();
      await vi.waitFor(() => expect(requests(route)).toHaveLength(asked + 1));
      mockStore.world.handBack(chat);
      mockStore.emit(RIVERA.slug, { type: 'writing' });
      await vi.waitFor(() => expect(headLine()).toMatch(/^You're chatting with Claude/));

      // It lands: Dana is verified, and the head never says Mike is back in the chat.
      const head = watchHead();
      late.release();
      await expect.element(screen.getByText(VERIFIED)).toBeVisible();
      head.stop();
      expect(head.seen().filter((line) => ownerLine.test(line)), answer).toEqual([]);
      expect(headLine(), answer).toMatch(/^You're chatting with Claude/);
    }
  });

  it('code_goes_only_to_the_verify_route', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    await screen.getByRole('textbox', { name: '6-digit code' }).fill(DEMO_CODE);
    await screen.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(screen.getByText(VERIFIED)).toBeVisible();
    expect(requests('verifyCheck').map((r) => r.body)).toEqual([{ code: DEMO_CODE }]);
    // Never in a message, and never on the chat's stream.
    expect(requests('sendMessage').length).toBeGreaterThan(0);
    for (const { body } of requests('sendMessage')) expect(JSON.stringify(body)).not.toContain(DEMO_CODE);
    for (const { ev } of chatEvents()) expect(JSON.stringify(ev)).not.toContain(DEMO_CODE);
    // Claude goes on with what was asked: the invoice, for her alone, with the receipts that explain it.
    const invoice = screen.getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    const invoiceReceipts = (card: Element) =>
      [...(card.closest('.cd-transcript-row')?.querySelectorAll('.cd-transcript-row__margin .cd-margin-receipt') ?? [])].map((el) => el.textContent?.trim());
    const explained = ["Document shared from Mike Turner's records"];
    await vi.waitFor(() => expect(invoiceReceipts(invoice.element())).toEqual(explained));

    // The same after a reload, read back from the stored conversation.
    const reloaded = await renderRoute(PAGE);
    const stored = reloaded.screen.getByRole('article', { name: 'Document, only for you' });
    await expect.element(stored).toBeVisible();
    expect(invoiceReceipts(stored.element())).toEqual(explained);
  });

  it('enter_in_the_field_sends_a_typed_code_once', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const field = screen.getByRole('textbox', { name: '6-digit code' });
    const input = field.element() as HTMLInputElement;

    // A wrong code typed in full, then Enter pressed in the field, not on Confirm: it goes once, and
    // the form says what Confirm's press would, with the field ready for the next code.
    await userEvent.type(field, '000000');
    await expect.element(field).toHaveValue('000000');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(requests('verifyCheck').map((r) => r.body)).toEqual([{ code: '000000' }]));
    await expect.element(screen.getByRole('alert')).toHaveTextContent(FAILED);
    await expect.element(field).toHaveAttribute('aria-invalid', 'true');
    await expect.element(field).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);

    // The right code typed over it, then Enter: it goes once, and the visitor is verified.
    await userEvent.keyboard(DEMO_CODE);
    await expect.element(field).toHaveValue(DEMO_CODE);
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText(VERIFIED)).toBeVisible();
    expect(requests('verifyCheck').map((r) => r.body)).toEqual([{ code: '000000' }, { code: DEMO_CODE }]);
  });

  it('enter_in_the_field_sends_a_pasted_code_once', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const field = screen.getByRole('textbox', { name: '6-digit code' });

    // Codes pasted as they come, plain, with a space or with a dash, each over the last one, then
    // Enter in the field: each goes once, as its six digits, as Confirm would send it.
    const pasted = ['615204', '123 456', '123-456', `${DEMO_CODE.slice(0, 3)} ${DEMO_CODE.slice(3)}`];
    for (const [index, text] of pasted.entries()) {
      await pasteInto(field.element() as HTMLInputElement, text);
      const digits = text.replace(/\D/g, '');
      await expect.element(field, { message: text }).toHaveValue(digits);
      await userEvent.keyboard('{Enter}');
      await vi.waitFor(() => expect(requests('verifyCheck'), text).toHaveLength(index + 1));
      expect(requests('verifyCheck').at(-1)?.body, text).toEqual({ code: digits });
      if (digits !== DEMO_CODE) await expect.element(screen.getByRole('alert'), { message: text }).toHaveTextContent(FAILED);
    }
    await expect.element(screen.getByText(VERIFIED)).toBeVisible();
    expect(requests('verifyCheck')).toHaveLength(pasted.length);
  });

  it('enter_in_the_field_sends_nothing_short_of_six_digits', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const field = screen.getByRole('textbox', { name: '6-digit code' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    // Five digits, then Enter: Confirm is disabled until the sixth, and Enter does as it would, nothing.
    await userEvent.type(field, DEMO_CODE.slice(0, 5));
    await userEvent.keyboard('{Enter}');
    // Time for a request to go out, had Enter sent one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('verifyCheck')).toEqual([]);
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
    await expect.element(confirm).toBeDisabled();
    await expect.element(field).toHaveValue(DEMO_CODE.slice(0, 5));
    await expect.element(field).toHaveFocus();

    // The sixth digit, then Enter: the code goes, once.
    await userEvent.keyboard(`${DEMO_CODE.slice(5)}{Enter}`);
    await expect.element(screen.getByText(VERIFIED)).toBeVisible();
    expect(requests('verifyCheck').map((r) => r.body)).toEqual([{ code: DEMO_CODE }]);
  });

  it('enter_while_a_code_is_checked_sends_nothing_more', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const field = screen.getByRole('textbox', { name: '6-digit code' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    // The verify route holds its answer until the test lets it land.
    let release = () => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    onTestFinished(() => release());
    mockStore.inject({ route: 'verifyCheck', status: 422, body: { error: 'kernel', code: 'invalid' }, until });

    await userEvent.type(field, '000000');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(requests('verifyCheck')).toHaveLength(1));
    await expect.element(confirm).toHaveAttribute('aria-busy', 'true');
    // While it is checked, Enter twice more in the field, then Tab to Confirm and press it: nothing
    // more goes. (A pointer click would wait for the busy button, `aria-disabled`, to be enabled.)
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await expect.element(confirm).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    // Time for a request to go out, had any press sent one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('verifyCheck')).toHaveLength(1);
    release();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(FAILED);
    expect(requests('verifyCheck').map((r) => r.body)).toEqual([{ code: '000000' }]);
  });

  it('wrong_code_copy_is_uniform', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    const field = screen.getByRole('textbox', { name: '6-digit code' });
    const session = mockStore.visitorSession(RIVERA.slug)?.state;
    if (!session) throw new Error('the chat has a session');

    // A code that didn't verify, a conflict, the kernel's invalid code, too many tries, and a code
    // the mock itself refuses: one line for all of them, which never says which it was.
    const refusals: [label: string, fault: Parameters<typeof mockStore.inject>[0] | null][] = [
      ['not verified', { route: 'verifyCheck', status: 200, body: { state: { ...session, verified: false } } }],
      ['409', { route: 'verifyCheck', status: 409, body: { error: 'kernel', code: 'conflict' } }],
      ['422 invalid', { route: 'verifyCheck', status: 422, body: { error: 'kernel', code: 'invalid' } }],
      ['429', { route: 'verifyCheck', status: 429, body: { error: 'rate_limited', retry_after: 5 } }],
      ['wrong code', null],
    ];
    for (const [index, [label, fault]] of refusals.entries()) {
      if (fault !== null) mockStore.inject(fault);
      await field.fill(label === 'wrong code' ? '000000' : DEMO_CODE);
      await screen.getByRole('button', { name: 'Confirm' }).click();
      await vi.waitFor(() => expect(requests('verifyCheck'), label).toHaveLength(index + 1));
      const line = screen.getByRole('alert');
      await expect.element(line, { message: label }).toHaveTextContent(FAILED);
      expect(line.elements(), label).toHaveLength(1);
      await expect.element(screen.getByText(VERIFIED)).not.toBeInTheDocument();
    }

    // No answer isn't a wrong code either: once the chat reads that it isn't verified, it says it
    // couldn't reach the Desk, and the code can be sent again.
    mockStore.inject({ route: 'verifyCheck', status: 503 });
    await field.fill(DEMO_CODE);
    await screen.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(screen.getByText(UNREACHABLE_COPY.en)).toBeVisible();
    await expect.element(screen.getByText(FAILED)).not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();

    // A 401 is the chat ending, not a wrong code: the session-ended line, and the form goes.
    mockStore.inject({ route: 'verifyCheck', status: 401 });
    await field.fill(DEMO_CODE);
    await screen.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(screen.getByText(CHAT_ENDED_COPY.en)).toBeVisible();
    await expect.element(screen.getByRole('button', { name: NEW_CHAT_LABEL.en })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: '6-digit code' })).not.toBeInTheDocument();
    await expect.element(screen.getByText(FAILED)).not.toBeInTheDocument();
  });

  it('verified_line_says_simulated', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you send my invoice?');
    await screen.getByRole('textbox', { name: '6-digit code' }).fill(DEMO_CODE);
    await screen.getByRole('button', { name: 'Confirm' }).click();
    // The code went to the contact on record, not proof the visitor holds it: the line says so.
    const line = screen.getByText(VERIFIED);
    await expect.element(line).toBeVisible();
    expect(mockStore.visitorSession(RIVERA.slug)?.state).toMatchObject({ verified: true, assurance: 'demo_code' });
    // In place of the form, under the message that asked for the code.
    await expect.element(screen.getByRole('textbox', { name: '6-digit code' })).not.toBeInTheDocument();
    const card = screen.getByRole('article', { name: "Confirm it's you" }).element();
    expect(card.closest('.cd-transcript-row')?.contains(line.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: false });

    // Read back after a reload, in a Spanish browser: the same line, in Spanish, and no form.
    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByText('Verificado con un código. Verificación simulada')).toBeVisible();
    await expect.element(es.screen.getByRole('textbox', { name: 'Código de 6 dígitos' })).not.toBeInTheDocument();
  });
});

describe('Demo inbox', () => {
  it('visitor_inbox_reads_only_session_entries', async () => {
    // The copy's Demo inbox already holds the owner's alert for the seeded hold.
    const alert = mockStore.world.inbox.find((record) => record.entry.kind === 'alert')?.entry;
    if (!alert) throw new Error('the seed holds a request, which alerts the owner');
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    // Nothing yet, so no inbox: the page is the chat as it always is.
    await expect.element(screen.getByRole('region', { name: 'Demo inbox' })).not.toBeInTheDocument();

    await say(screen, 'Can you send my invoice?');
    const inbox = screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(inbox.getByText(CODE_BODY)).toBeVisible();
    await expect.element(inbox.getByText('Verification code', { exact: true })).toBeVisible();
    await expect.element(inbox.getByText(`To ${rivera.people.dana.maskedContact}`)).toBeVisible();
    // Only this chat's codes: the visitor's own read, never the owner's, and never the owner's alert.
    expect(requests('visitorInbox').length).toBeGreaterThanOrEqual(2);
    expect(requests('ownerInbox')).toEqual([]);
    expect(screen.container.textContent).not.toContain(alert.body);
    // A column beside the chat on a wide window.
    expect(inbox.element().closest('.cd-public-chat__inbox-column')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: false });

    // At phone width it is a sheet over the page, read again after the reload: the code is still
    // awaited, so the sheet opens itself with it.
    const phone = await renderRoute(PAGE, { viewport: 'phone' });
    const sheet = phone.screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(CODE_BODY)).toBeVisible();
    expect(sheet.element().closest('.cd-public-chat__inbox-column')).toBeNull();
    expect(phone.screen.container.querySelector('.cd-public-chat__inbox-column')).toBeNull();
    expectNoHorizontalScroll();
  });

  it('inbox_sheet_opens_on_the_first_code', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(screen);
    // Nothing to read yet, and no code asked for: no Demo inbox on the page.
    expect(screen.getByRole('button', { name: /^Demo inbox/ }).elements()).toHaveLength(0);

    // The code arrives and the sheet opens itself from the bottom, over the page, its heading
    // focused so the visitor's next key doesn't close it.
    await say(screen, 'Can you send my invoice?');
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(CODE_BODY)).toBeVisible();
    await expect.element(sheet.getByRole('heading', { level: 2, name: 'Demo inbox' })).toHaveFocus();
    await expect.element(sheet.getByText(VISITOR_SUBTITLE)).toBeVisible();
    await expect.element(sheet.getByText(`To ${rivera.people.dana.maskedContact}`)).toBeVisible();
    const box = sheet.element().getBoundingClientRect();
    expect([Math.round(box.left), Math.round(box.width), Math.round(box.bottom)]).toEqual([0, 390, 844]);
    expect(sheet.element().textContent).not.toMatch(/\d{1,2}:\d{2}/);
    await expectScreenBasics(screen.container, { owner: false });

    // Escape closes it. Its button, under the conversation in its scroll region, counts the code
    // and opens it again, focus on Close; closing goes back to the button.
    await userEvent.keyboard('{Escape}');
    await expect.element(sheet).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Demo inbox 1 entry' });
    await expect.element(button).toBeVisible();
    expect(button.element().closest('.cd-public-shell__scroll .cd-public-shell__conversation')).not.toBeNull();
    await button.click();
    const again = screen.getByRole('dialog', { name: 'Demo inbox' });
    const close = again.getByRole('button', { name: 'Close' });
    await expect.element(close).toHaveFocus();
    await close.click();
    await expect.element(again).not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
    expectNoHorizontalScroll();
  });

  it('inbox_sheet_opens_when_the_code_comes_before_the_card', async () => {
    // The API streams a code's notice while Claude is still answering, before the verify card.
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(screen);
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('the page opened a chat');
    const notice = mockStore.world
      .context(chat, 'en', '')
      .startVerification({ person: rivera.people.dana, code: DEMO_CODE, body: CODE_BODY, preview: 'New verification code' });
    mockStore.emit(RIVERA.slug, notice);

    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(CODE_BODY)).toBeVisible();
    await expect.element(sheet.getByRole('heading', { level: 2, name: 'Demo inbox' })).toHaveFocus();
    expect(requests('ownerInbox')).toEqual([]);
  });

  it('inbox_that_cant_be_read_names_itself_below_1280', async () => {
    // A reload while the code is awaited, whose read on load fails: under the conversation, the
    // inbox's title over its line and "Try again", never a sheet that would say it's empty.
    const first = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(first.screen);
    await say(first.screen, 'Can you send my invoice?');
    await expect.element(first.screen.getByRole('dialog', { name: 'Demo inbox' }).getByText(CODE_BODY)).toBeVisible();

    mockStore.inject({ route: 'visitorInbox', status: 500 });
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(screen);
    const place = screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(place.getByText(INBOX_FAILED)).toBeVisible();
    await expect.element(place.getByRole('heading', { level: 2, name: 'Demo inbox' })).toBeVisible();
    expect(screen.getByRole('dialog').elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Demo inbox/ }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });
    expectNoHorizontalScroll();

    // Reading again works: the line goes and the sheet opens itself with the code.
    await place.getByRole('button', { name: 'Try again' }).click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(CODE_BODY)).toBeVisible();
    await expect.element(screen.getByText(INBOX_FAILED)).not.toBeInTheDocument();
  });

  it('inbox_retry_after_failure', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    // The read when the chat opened went through; the one for the code's notice fails once.
    await vi.waitFor(() => expect(requests('visitorInbox')).toHaveLength(1));
    mockStore.inject({ route: 'visitorInbox', status: 500 });
    await say(screen, 'Can you send my invoice?');
    const inbox = screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(inbox.getByText('Couldn’t open this entry.')).toBeVisible();
    // The notice's own words show while the entry can't, never a code.
    await expect.element(inbox.getByText('New verification code')).toBeVisible();
    expect(inbox.element().textContent).not.toMatch(/\d{6}/);

    await inbox.getByRole('button', { name: 'Try again' }).click();
    await expect.element(inbox.getByText(CODE_BODY)).toBeVisible();
    await expect.element(inbox.getByText('Couldn’t open this entry.')).not.toBeInTheDocument();
    expect(requests('visitorInbox')).toHaveLength(3);

    // The page reloads while the code is still awaited, and the read on load fails: no notice names
    // an entry, but the inbox's place still says it couldn't open, with "Try again", never blank.
    mockStore.inject({ route: 'visitorInbox', status: 500 });
    const reloaded = await renderRoute(PAGE);
    await ready(reloaded.screen);
    const place = reloaded.screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(place.getByText(INBOX_FAILED)).toBeVisible();
    // The column names itself over the line, as the panel does.
    await expect.element(place.getByRole('heading', { level: 2, name: 'Demo inbox' })).toBeVisible();
    expect(place.element().textContent).not.toMatch(/\d{6}/);
    expect(place.element().closest('.cd-public-chat__inbox-column')).not.toBeNull();
    await expectScreenBasics(reloaded.screen.container, { owner: false });
    await place.getByRole('button', { name: 'Try again' }).click();
    const opened = reloaded.screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(opened.getByText(CODE_BODY)).toBeVisible();
    await expect.element(reloaded.screen.getByText(INBOX_FAILED)).not.toBeInTheDocument();
    expect(requests('visitorInbox')).toHaveLength(5);

    // Once she has confirmed it's her, a failed read on load has nothing awaited to say: no place.
    await reloaded.screen.getByRole('textbox', { name: '6-digit code' }).fill(DEMO_CODE);
    await reloaded.screen.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(reloaded.screen.getByText(VERIFIED)).toBeVisible();
    mockStore.inject({ route: 'visitorInbox', status: 500 });
    const after = await renderRoute(PAGE);
    await expect.element(after.screen.getByText(VERIFIED)).toBeVisible();
    await vi.waitFor(() => expect(requests('visitorInbox')).toHaveLength(6));
    await expect.element(after.screen.getByRole('region', { name: 'Demo inbox' })).not.toBeInTheDocument();
  });

  it('owner_notifications_show_alerts', async () => {
    // The seeded hold alerted the owner: the kernel's line for it, word for word.
    const alert = mockStore.world.inbox.find((record) => record.entry.kind === 'alert')?.entry;
    if (!alert) throw new Error('the seed holds a request, which alerts the owner');
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`);
    // Under Safety in the sidebar, read once as the frame opens, so its count is what is unread
    // there, and not again while the page is shut.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const row = nav.getByRole('link', { name: /^Notifications \d+ unread$/ });
    await expect.element(row).toBeVisible();
    const heading = screen.getByRole('heading', { level: 1, name: 'Notifications' });
    const closedReads = closedInboxReads(heading);
    expect(requests('ownerInbox')).toHaveLength(1);
    await aPollPasses();
    expect(closedReads()).toBe(0);

    // Its page: the alert, headed by its title, and no word of who it went to, the owner's own.
    await row.click();
    await expect.element(heading).toBeVisible();
    const page = screen.getByRole('main');
    await expect.element(page.getByText(alert.body)).toBeVisible();
    // Unread as the page opened, so a screen reader hears that before its heading: the alert's
    // title, the kernel's fixed line for a request held for the owner.
    expect([...page.element().querySelectorAll('.cd-notifications__kind')].map((kind) => kind.textContent)).toContain('Unread: A request needs your answer');
    expect(page.getByText('To owner').elements()).toHaveLength(0);
    await expect.element(page.getByText(OWNER_SUBTITLE)).toBeVisible();
    // When it came, on the business's clock, under its day.
    expect(page.element().querySelector('.cd-notifications__time')?.textContent).toMatch(/^\d{1,2}:\d{2} (?:am|pm)$/);
    await expectScreenBasics(screen.container, { owner: true });

    // It reads again while open, and stops once left.
    await vi.waitFor(() => expect(requests('ownerInbox').length).toBeGreaterThanOrEqual(3));
    await nav.getByRole('link', { name: 'Today' }).click();
    await expect.element(heading).not.toBeInTheDocument();
    await aPollPasses();
    expect(closedReads()).toBe(0);
    // Its own codes stay the visitor's: the owner's notifications never call the visitor's read.
    expect(requests('visitorInbox')).toEqual([]);
  });

  it('owner_notifications_that_cant_be_read_say_so', async () => {
    // The frame reads the notifications as it opens, on any page. When that read and its retry
    // fail, the sidebar counts none, and the page says they couldn't be opened, with "Try again",
    // never that there are none.
    mockStore.inject({ route: 'ownerInbox', status: 500, times: 4 });
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/rules`, { retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' }), { timeout: 4_000 }).toBeVisible();
    const row = screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notifications', exact: true });
    await expect.element(row).toBeVisible();
    await vi.waitFor(() => expect(requests('ownerInbox')).toHaveLength(2));
    expect(screen.getByText(`Couldn't open your notifications. ${UNAVAILABLE}`, { exact: true }).elements()).toHaveLength(0);

    // The read as the page opens fails too: the line, alone.
    await row.click();
    const page = screen.getByRole('main');
    const line = page.getByText(`Couldn't open your notifications. ${UNAVAILABLE}`, { exact: true });
    await expect.element(line, { timeout: 4_000 }).toBeVisible();
    expect(page.element().querySelector('.cd-empty-state')).toBeNull();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.element(line).not.toBeInTheDocument();
    await expect.element(page.getByRole('list')).toBeVisible();
  });

  it('owner_notifications_that_cant_be_read_on_a_reload_hold_nothing', async () => {
    // Reloaded, Today opens without waiting for the notifications; their slow read and retry fail,
    // and the sidebar counts none, without sending the read again.
    mockStore.inject({ route: 'ownerInbox', status: 500, times: 2, delayMs: 300 });
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`, { retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    await vi.waitFor(() => expect(requests('ownerInbox')).toHaveLength(2));
    await expect.element(screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();
    // Time for a read on mount to go out, had anything sent the failed one again.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests('ownerInbox')).toHaveLength(2);
  });

  it('owner_notifications_that_failed_are_read_again_as_their_page_opens', async () => {
    // A failed read isn't sent again as the owner moves between pages; the page reads it again as
    // it opens, and once that read works the entries show. Under StrictMode, as the app runs, so
    // every render and effect runs twice on mount.
    mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`, { retryScale: 0, strict: true });
    await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    await vi.waitFor(() => expect(requests('ownerInbox')).toHaveLength(2));

    const nav = screen.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Rules' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' }), { timeout: 4_000 }).toBeVisible();
    await nav.getByRole('link', { name: 'Today' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    expect(requests('ownerInbox')).toHaveLength(2);

    await nav.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect.element(screen.getByRole('main').getByRole('list')).toBeVisible();
    expect(requests('ownerInbox').length).toBeGreaterThanOrEqual(3);
  });

  it('owner_notifications_refresh_that_fails_says_so', async () => {
    // Once the notifications have been read, a later read that fails says so on the page, with "Try
    // again", over the entries read before, so they never pass for current. Polls far apart, so only
    // the reads this test makes go out.
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`, { pollScale: 100 });
    const row = screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Notifications \d+ unread$/ });
    await expect.element(row).toBeVisible();
    expect(requests('ownerInbox')).toHaveLength(1);

    // The read as the page opens fails, and so does its retry.
    mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
    await row.click();
    const page = screen.getByRole('main');
    const line = page.getByText(`Couldn't open your notifications. ${UNAVAILABLE}`, { exact: true });
    await expect.element(line, { timeout: 4_000 }).toBeVisible();
    await expect.element(page.getByRole('list')).toBeVisible();
    expect(line.element().compareDocumentPosition(page.getByRole('list').element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectScreenBasics(screen.container, { owner: true });

    // "Try again" reads it again, and the line goes.
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.element(line).not.toBeInTheDocument();
    await expect.element(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  });
});

