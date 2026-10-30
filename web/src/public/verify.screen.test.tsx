/**
 * Demo-code verification and the Demo inbox in a real browser against the mock API: the code form
 * under the kernel's verify card, the code going only to the verify route, one line for every
 * failed code, the simulated label once it works, and the inbox each side reads.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { VisitorEvent } from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { CHAT_ENDED_COPY, NEW_CHAT_LABEL, UNREACHABLE_COPY } from '../ds/index.ts';
import { DEMO_CODE } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const PAGE = `/d/${RIVERA.slug}`;

/** The chat's line once a demo code works, with the design system's simulated label. */
const VERIFIED = 'Verified with a code. Simulated verification';

/** The form's one line for a code that didn't work, whatever the reason. */
const FAILED = 'That code didn’t work. Check the newest code, or ask me for a new one.';

/** What the Demo inbox entry for the invoice row's code says, word for word: the kernel's `inbox_code_body`. */
const CODE_BODY = `Your Rivera Plumbing code is ${DEMO_CODE}. It expires in ten minutes. If you didn't ask for it, ignore this message.`;

/** The inbox's place when it couldn't be read at all, so no entry can say it failed. */
const INBOX_FAILED = 'Couldn’t open the Demo inbox, where your code arrives.';

/** Claude's checked line before the verify card, as the signed verify board writes it. */
const VERIFY_FIRST = "I can send that after you confirm it's you.";

/** The kernel's verify card, as the script's invoice row sends it. */
const VERIFY_CARD = rivera.blocks.verify_prompt.en.title ?? '';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Every event this browser's chat with Rivera has carried, in order. */
function chatEvents(): { seq: number; ev: VisitorEvent }[] {
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
    expect(receipts).toEqual(["Reply checked against Maria Rivera's rules", 'Verification started']);
    await expectScreenBasics(screen.container, { owner: false });
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
    const explained = ["Reply checked against Maria Rivera's rules", "Document shared from Maria Rivera's records"];
    await vi.waitFor(() => expect(invoiceReceipts(invoice.element())).toEqual(explained));

    // The same after a reload, read back from the stored conversation.
    const reloaded = await renderRoute(PAGE);
    const stored = reloaded.screen.getByRole('article', { name: 'Document, only for you' });
    await expect.element(stored).toBeVisible();
    expect(invoiceReceipts(stored.element())).toEqual(explained);
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

    // At phone width it sits with the chat, read again after the reload, the code still there.
    const phone = await renderRoute(PAGE, { viewport: 'phone' });
    const narrow = phone.screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(narrow.getByText(CODE_BODY)).toBeVisible();
    expect(narrow.element().closest('.cd-public-chat__inbox-column')).toBeNull();
    expectNoHorizontalScroll();
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

  it('owner_inbox_shows_alerts', async () => {
    // The seeded hold alerted the owner: the kernel's line for it, word for word.
    const alert = mockStore.world.inbox.find((record) => record.entry.kind === 'alert')?.entry;
    if (!alert) throw new Error('the seed holds a request, which alerts the owner');
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`);
    const open = screen.getByRole('button', { name: 'Open the Demo inbox' });
    await expect.element(open).toBeVisible();
    // Nothing is read until the owner opens it.
    expect(requests('ownerInbox')).toEqual([]);

    await open.click();
    const inbox = screen.getByRole('region', { name: 'Demo inbox' });
    await expect.element(inbox.getByText(alert.body)).toBeVisible();
    await expect.element(inbox.getByText('Alert', { exact: true })).toBeVisible();
    await expect.element(inbox.getByText('To owner')).toBeVisible();
    // When it came, on the business's clock.
    expect(inbox.element().querySelector('.cd-demo-inbox__time')?.textContent).toMatch(/^(?:Today|[A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} (?:am|pm)$/);
    await expectScreenBasics(screen.container, { owner: true });

    // It reads again while open, and stops once closed.
    await vi.waitFor(() => expect(requests('ownerInbox').length).toBeGreaterThanOrEqual(2));
    await screen.getByRole('button', { name: 'Close the Demo inbox' }).click();
    await expect.element(screen.getByRole('region', { name: 'Demo inbox' })).not.toBeInTheDocument();
    const reads = requests('ownerInbox').length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(requests('ownerInbox')).toHaveLength(reads);
    // Its own codes stay the visitor's: the owner's inbox never calls the visitor's read.
    expect(requests('visitorInbox')).toEqual([]);
  });
});
