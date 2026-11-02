/**
 * Setup's choice dock in a real browser against the mock API, at 1440 and 390 px. A question whose
 * choices can be picked together (`several`) docks them as checkbox rows, as in Claude Code: Space
 * and the row digits toggle, the arrows move, and Enter or Send sends the picks with any words typed
 * in "Something else…", which the API writes into one message. While any question docks, the message
 * box is hidden; Esc gives the question back to the chat and the box back to the owner.
 */
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { RouteKey } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { SALON_TIME, SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { SETUP_COPY } from './copy.ts';

const SALON = 'I’m Priya Shah. Juniper Hair Studio is a four-chair salon in Oakland doing cuts, color and balayage. We’re open Tuesday to Saturday.';
const CPA = "I'm Linda Chen. Chen & Co. is a two-person CPA firm in San Jose doing tax returns and bookkeeping for individuals and small businesses. New clients start with a free 20-minute consult, and we price each engagement after it.";
const [BOOKING, PRICES, DEPOSITS, CANCELLATIONS] = SALON_TIME.choices;

const requests = (key: RouteKey) => mockStore.requests.filter((r) => r.key === key);

/** A new interview in the mock with its memory question answered: the salon's asks several at once, the CPA firm's one. */
async function asked(description: string): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const id = (started.body as SetupState).interview_id;
  const consented = await mockStore.dispatch('setupConsent', { params: { id }, query: { cards: '1' }, body: { allow: description === CPA } });
  if ('network' in consented || consented.status !== 200) throw new Error('the mock takes the consent');
  return consented.body as SetupState;
}

async function openDock(description: string, viewport: Viewport = 'desktop') {
  const state = await asked(description);
  const question = state.messages.at(-1)!.text;
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
  const panel = screen.getByRole('region', { name: question, exact: true });
  await expect.element(panel).toBeVisible();
  return { state, question, screen, panel };
}

const box = () => document.querySelector<HTMLTextAreaElement>('.cd-setup-dock textarea');
const checked = (panel: { getByRole: (role: 'checkbox') => { elements: () => Element[] } }) =>
  panel.getByRole('checkbox').elements().map((row) => row.getAttribute('aria-checked'));
/** Whether "Something else…" counts as picked: its box is drawn checked. */
const typedRowPicked = () => document.querySelector('.cd-setup-q3__row--other .cd-setup-q3__box')?.classList.contains('is-checked');

describe.each(['desktop', 'phone'] as const)('a question that takes several answers at %s', (viewport) => {
  it('docks_its_choices_as_checkbox_rows_with_space_to_toggle_and_send_and_hides_the_message_box', async () => {
    const { screen, panel } = await openDock(SALON, viewport);
    const rows = panel.getByRole('checkbox');
    expect(rows.elements().map((row) => row.getAttribute('aria-label'))).toEqual([...SALON_TIME.choices]);
    expect(checked(panel)).toEqual(['false', 'false', 'false', 'false']);
    // The kbd number, then the box, then the words; "Something else…" keeps its label, with its number and an empty box.
    expect([...panel.element().querySelectorAll('.cd-setup-q3__row > kbd')].map((key) => key.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(panel.element().querySelectorAll('.cd-setup-q3__row .cd-setup-q3__box')).toHaveLength(5);
    await expect.element(panel.getByRole('textbox', { name: 'Something else…', exact: true })).toBeVisible();
    expect(typedRowPicked()).toBe(false);
    // The hint: the arrows to move, Space to toggle, Enter to send, Esc to type instead, then Send.
    const hint = panel.element().querySelector<HTMLElement>('.cd-setup-q3__hint')!;
    expect(hint.textContent).toBe('Up arrowDown arrow to moveSpace to toggleEnter to sendEsc to type insteadSend');
    await expect.element(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    // The message box is hidden while the question docks.
    expect(screen.getByRole('textbox', { name: 'Your answer', exact: true }).elements()).toHaveLength(0);
    expect(box()).not.toBeNull();
    expect(box()!.checkVisibility()).toBe(false);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('esc_gives_the_question_back_to_the_chat_and_the_message_box_back_with_focus', async () => {
    const { screen, panel, question } = await openDock(SALON, viewport);
    await panel.getByRole('checkbox', { name: BOOKING, exact: true }).click();
    await userEvent.keyboard('{Escape}');
    expect(panel.elements()).toHaveLength(0);
    await expect.element(screen.getByRole('log').getByText(question, { exact: true })).toBeVisible();
    const answer = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await expect.element(answer).toBeVisible();
    await expect.element(answer).toHaveFocus();
    expect(requests('setupAnswer')).toHaveLength(0);
    expectNoHorizontalScroll();
  });
});

describe('a question that takes several answers', () => {
  it('space_and_digits_toggle_the_arrows_move_and_enter_sends_the_picks_with_the_typed_words', async () => {
    const { screen, panel, state } = await openDock(SALON);
    const rows = panel.getByRole('checkbox');
    (rows.first().element() as HTMLElement).focus();
    await userEvent.keyboard(' ');
    expect(checked(panel)).toEqual(['true', 'false', 'false', 'false']);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect.element(rows.nth(2)).toHaveFocus();
    await expect.element(rows.nth(2)).toHaveClass('is-active');
    expect(checked(panel)).toEqual(['true', 'false', 'false', 'false']);
    await userEvent.keyboard(' ');
    expect(checked(panel)).toEqual(['true', 'false', 'true', 'false']);
    // A row's digit toggles it, and moves there; again, it clears it.
    await userEvent.keyboard('2');
    await expect.element(rows.nth(1)).toHaveFocus();
    expect(checked(panel)).toEqual(['true', 'true', 'true', 'false']);
    await userEvent.keyboard('2');
    expect(checked(panel)).toEqual(['true', 'false', 'true', 'false']);
    // The last digit is "Something else…", straight after the row digits too: typed words count as picked,
    // digits and spaces as words.
    await userEvent.keyboard('5');
    const other = panel.getByRole('textbox', { name: 'Something else…', exact: true });
    await expect.element(other).toHaveFocus();
    expect(typedRowPicked()).toBe(false);
    await userEvent.keyboard('Walk-ins at 5 pm');
    await expect.element(other).toHaveValue('Walk-ins at 5 pm');
    expect(typedRowPicked()).toBe(true);
    expect(checked(panel)).toEqual(['true', 'false', 'true', 'false']);
    expect(requests('setupAnswer')).toHaveLength(0);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, picks: [BOOKING, DEPOSITS], text: 'Walk-ins at 5 pm' }]);
    // The API's one message: the picks in the listed order, then the typed words on their own line.
    const log = screen.getByRole('log');
    await expect.poll(() => [...log.element().querySelectorAll('.cd-visitor-message__bubble')].map((bubble) => bubble.textContent).at(-1)).toBe(`${BOOKING}, ${DEPOSITS}\nWalk-ins at 5 pm`);
    await expect.element(log.getByText(SALON_TIME.text, { exact: true })).toBeVisible();
    expect(panel.elements()).toHaveLength(0);
  });

  it('send_sends_the_rows_picked_by_pointer_and_nothing_until_one_is_picked', async () => {
    const { panel, state } = await openDock(SALON);
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    await expect.element(send).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await panel.getByRole('checkbox', { name: CANCELLATIONS, exact: true }).click();
    await panel.getByRole('checkbox', { name: PRICES, exact: true }).click();
    expect(checked(panel)).toEqual(['false', 'true', 'false', 'true']);
    // A click clears a row as Space does.
    await panel.getByRole('checkbox', { name: CANCELLATIONS, exact: true }).click();
    await panel.getByRole('checkbox', { name: CANCELLATIONS, exact: true }).click();
    await expect.element(send).toBeEnabled();
    expect(requests('setupAnswer')).toHaveLength(0);
    await send.click();
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, picks: [PRICES, CANCELLATIONS] }]);
  });

  it('typed_words_alone_answer_as_typed_and_a_key_on_a_row_types_into_something_else', async () => {
    const { panel, state } = await openDock(SALON);
    const rows = panel.getByRole('checkbox');
    (rows.nth(1).element() as HTMLElement).focus();
    // A printable key on a row goes to "Something else…", as on a question that takes one answer.
    await userEvent.keyboard('Mostly color');
    const other = panel.getByRole('textbox', { name: 'Something else…', exact: true });
    await expect.element(other).toHaveFocus();
    await expect.element(other).toHaveValue('Mostly color');
    expect(typedRowPicked()).toBe(true);
    expect(checked(panel)).toEqual(['false', 'false', 'false', 'false']);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, text: 'Mostly color' }]);
  });
});

describe('words typed on a question that takes several answers', () => {
  it('words_typed_from_the_page_go_to_something_else_spaces_and_all', async () => {
    const { panel, state } = await openDock(SALON);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard('Walk-ins asking for a slot');
    const other = panel.getByRole('textbox', { name: 'Something else…', exact: true });
    await expect.element(other).toHaveValue('Walk-ins asking for a slot');
    await expect.element(other).toHaveFocus();
    expect(checked(panel)).toEqual(['false', 'false', 'false', 'false']);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, text: 'Walk-ins asking for a slot' }]);
  });

  it.each(['page', 'row'] as const)('digits_always_tick_their_rows_and_the_typed_rows_digit_keeps_the_ticks_from_the_%s', async (from) => {
    // Each digit is a tick the owner can see: 1 to 4 always toggle, and 5 moves into "Something else…".
    const { panel } = await openDock(SALON);
    if (from === 'row') (panel.getByRole('checkbox').first().element() as HTMLElement).focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('135');
    const other = panel.getByRole('textbox', { name: 'Something else…', exact: true });
    await expect.element(other).toHaveFocus();
    await expect.element(other).toHaveValue('');
    expect(checked(panel)).toEqual(['true', 'false', 'true', 'false']);
    expect(typedRowPicked()).toBe(false);
  });

  it.each(['page', 'row'] as const)('words_after_row_digits_keep_the_ticks_from_the_%s', async (from) => {
    const { panel, state } = await openDock(SALON);
    if (from === 'row') (panel.getByRole('checkbox').first().element() as HTMLElement).focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('13Gift');
    const other = panel.getByRole('textbox', { name: 'Something else…', exact: true });
    await expect.element(other).toHaveValue('Gift');
    expect(checked(panel)).toEqual(['true', 'false', 'true', 'false']);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, picks: [BOOKING, DEPOSITS], text: 'Gift' }]);
  });

  it('space_on_send_sends_and_toggles_nothing', async () => {
    const { panel, state } = await openDock(SALON);
    await panel.getByRole('checkbox', { name: PRICES, exact: true }).click();
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    (send.element() as HTMLElement).focus();
    await userEvent.keyboard(' ');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, picks: [PRICES] }]);
  });

  it('a_click_after_a_digit_leaves_no_digit_behind_in_the_words', async () => {
    const { panel, state } = await openDock(SALON);
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('1');
    expect(checked(panel)).toEqual(['true', 'false', 'false', 'false']);
    await panel.getByRole('checkbox', { name: BOOKING, exact: true }).click();
    expect(checked(panel)).toEqual(['false', 'false', 'false', 'false']);
    await userEvent.keyboard('W{Enter}');
    await expect.poll(() => requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, text: 'W' }]);
  });

  it('a_held_digit_or_space_toggles_its_row_once', async () => {
    const { panel } = await openDock(SALON);
    const first = panel.getByRole('checkbox').first().element() as HTMLElement;
    first.focus();
    // The repeats of a held key toggle nothing more.
    const repeat = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true }));
    await userEvent.keyboard('1');
    repeat('1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(checked(panel)).toEqual(['true', 'false', 'false', 'false']);
    await userEvent.keyboard('{ArrowDown} ');
    repeat(' ');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(checked(panel)).toEqual(['true', 'true', 'false', 'false']);
    expect(panel.getByRole('textbox', { name: 'Something else…', exact: true }).element()).toHaveProperty('value', '');
  });
});

describe('words typed in "Something else…" go on in the message box', () => {
  it.each([['Esc', 'several'], ['Dismiss', 'several'], ['Esc', 'one'], ['Dismiss', 'one']] as const)('%s_keeps_them_on_a_question_that_takes_%s', async (how, takes) => {
    const description = takes === 'several' ? SALON : CPA;
    const { screen, panel, question } = await openDock(description);
    if (description === SALON) await panel.getByRole('checkbox', { name: BOOKING, exact: true }).click();
    await panel.getByRole('textbox', { name: 'Something else…', exact: true }).fill('Walk-ins asking for a slot');
    if (how === 'Esc') await userEvent.keyboard('{Escape}');
    else await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
    expect(panel.elements()).toHaveLength(0);
    await expect.element(screen.getByRole('log').getByText(question, { exact: true })).toBeVisible();
    const answer = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await expect.element(answer).toHaveValue('Walk-ins asking for a slot');
    await expect.element(answer).toHaveFocus();
    expect(requests('setupAnswer')).toHaveLength(0);
  });
});

describe('picks whose reply is lost', () => {
  it('stored_picks_are_neither_put_back_nor_sent_again', async () => {
    const { screen, panel, state } = await openDock(SALON);
    mockStore.inject({ route: 'setupAnswer', status: 'network', afterCommit: true });
    await panel.getByRole('checkbox', { name: PRICES, exact: true }).click();
    await panel.getByRole('checkbox', { name: BOOKING, exact: true }).click();
    await panel.getByRole('textbox', { name: 'Something else…', exact: true }).fill('Walk-ins');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    // The read finds the API's message for them, so the page moves on, with nothing given back.
    const log = screen.getByRole('log');
    await expect.element(log.getByText(`Got it. ${SETUP_QUESTIONS[1]!.text}`, { exact: true })).toBeVisible();
    expect(screen.getByText(SETUP_COPY.questions.failed, { exact: true }).elements()).toHaveLength(0);
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveValue('');
    expect(requests('setupAnswer').map(({ body }) => body)).toEqual([{ question: state.question, picks: [BOOKING, PRICES], text: 'Walk-ins' }]);
    const bubbles = [...log.element().querySelectorAll('.cd-visitor-message__bubble')].map((bubble) => bubble.textContent);
    expect(bubbles.filter((text) => text === `${BOOKING}, ${PRICES}\nWalk-ins`)).toHaveLength(1);
  });

  it('try_again_sends_the_same_picks_when_nothing_was_stored', async () => {
    const { screen, panel, state } = await openDock(SALON);
    mockStore.inject({ route: 'setupAnswer', status: 'network' });
    await panel.getByRole('checkbox', { name: CANCELLATIONS, exact: true }).click();
    await panel.getByRole('textbox', { name: 'Something else…', exact: true }).fill('Walk-ins');
    await userEvent.keyboard('{Enter}');
    const retry = screen.getByRole('button', { name: 'Try again', exact: true });
    await expect.element(retry).toBeVisible();
    await expect.element(screen.getByText(SETUP_COPY.questions.failed, { exact: true })).toBeVisible();
    await retry.click();
    await expect.element(screen.getByRole('log').getByText(`Got it. ${SETUP_QUESTIONS[1]!.text}`, { exact: true })).toBeVisible();
    const sent = { question: state.question, picks: [CANCELLATIONS], text: 'Walk-ins' };
    expect(requests('setupAnswer').map(({ body }) => body)).toEqual([sent, sent]);
  });
});

describe.each(['desktop', 'phone'] as const)('a question that takes one answer at %s', (viewport) => {
  it('keeps_its_rows_and_hides_the_message_box_until_esc', async () => {
    const { screen, panel, question } = await openDock(CPA, viewport);
    expect(panel.getByRole('checkbox').elements()).toHaveLength(0);
    expect(panel.getByRole('list').getByRole('button').elements().map((row) => row.getAttribute('aria-label'))).toEqual(['Both, about evenly', 'Mostly individuals', 'Mostly small businesses']);
    expect(panel.element().querySelector('.cd-setup-q3__box')).toBeNull();
    expect(panel.getByRole('button', { name: 'Send', exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Your answer', exact: true }).elements()).toHaveLength(0);
    expect(box()!.checkVisibility()).toBe(false);
    await userEvent.keyboard('{Escape}');
    expect(panel.elements()).toHaveLength(0);
    await expect.element(screen.getByRole('log').getByText(question, { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveFocus();
  });
});
