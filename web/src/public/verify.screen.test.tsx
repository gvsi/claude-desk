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
import { expectScreenBasics } from '../test/screen.ts';

const PAGE = `/d/${RIVERA.slug}`;

/** The chat's line once a demo code works, with the design system's simulated label. */
const VERIFIED = 'Verified with a code. Simulated verification';

/** The form's one line for a code that didn't work, whatever the reason. */
const FAILED = 'That code didn’t work. Check the newest code, or ask me for a new one.';

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
    // The form sits with the message that asked for the code, under its receipts.
    const row = card.element().closest('.cd-transcript-row');
    expect(row?.querySelector('.cd-transcript-row__margin input[autocomplete="one-time-code"]')).not.toBeNull();
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
    // Claude goes on with what was asked: the invoice, for her alone.
    await expect.element(screen.getByRole('article', { name: 'Document, only for you' })).toBeVisible();
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
