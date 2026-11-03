/**
 * Ask Claude's answer as it is written, in a real browser against the mock API at 1440 and 390 px:
 * the answer grows in Claude's serif where its writing dots were, and the change it drafts shows
 * only once the answer is final. A stream that fails says so as the JSON answer would; one that
 * breaks off is asked again as JSON; closing the panel closes it.
 */
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import type { RouteKey } from '../../api/routes.ts';
import { RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import { DRAFT_FAILED } from './RuleChat.tsx';
import { settledWords } from '../../lib/GrowingReply.tsx';
import { growingWords } from '../../mocks/ownerStreams.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute, type Viewport } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const RULES = `/app/${RIVERA.deskId}/rules`;
const ASK = 'Stop quoting on weekends';
const ANSWER = "Here's that change: quotes stay automatic on weekdays, and on weekends they wait for your answer. Nothing changes until you confirm it.";
/** A change Claude drafts that would take money on its own above the payment limit. */
const PAYMENT_LINKS = 'Send payment links on your own up to $800';

const requests = (key: RouteKey) => mockStore.requests.filter((r) => r.key === key);

/** A gate a planned stream waits at, and the function that lets it go. */
function gate(): { until: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release };
}

/** Opens Rules at `viewport` and asks Claude `words` from the page's composer; resolves to the panel. */
async function ask(viewport: Viewport, words = ASK) {
  const { screen } = await renderRoute(RULES, { viewport });
  const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
  await expect.element(composer, { timeout: 4_000 }).toBeVisible();
  await composer.fill(words);
  await userEvent.keyboard('{Enter}');
  // Beside the page it is a complementary panel; at 390 px, a full sheet over it.
  const panel = viewport === 'phone' ? screen.getByRole('dialog', { name: 'Ask Claude' }) : screen.getByRole('complementary', { name: 'Ask Claude' });
  await expect.element(panel, { timeout: 4_000 }).toBeVisible();
  return { screen, panel };
}

/** The answer growing in the panel, or null. */
const growing = (panel: { element(): Element }) => panel.element().querySelector<HTMLElement>('.cd-rule-chat__growing');

/** How long a long answer may take to land on a loaded machine. */
const LANDS_WITHIN = { timeout: 20_000 };

/**
 * The final answer in the panel holding `words`, once it has landed: read from the answer's own
 * text, however the Markdown renderer splits it into elements.
 */
async function finalAnswer(panel: { element(): Element }, words: string): Promise<HTMLElement> {
  const landed = () =>
    [...panel.element().querySelectorAll<HTMLElement>('.cd-rule-chat__answer:not(.cd-rule-chat__growing)')].find((answer) =>
      (answer.textContent ?? '').includes(words),
    ) ?? null;
  await expect.poll(landed, LANDS_WITHIN).not.toBeNull();
  return landed()!;
}

describe.each(['desktop', 'phone'] as const)('Ask Claude streaming at %s', (viewport) => {
  it('grows_the_answer_then_shows_the_final_draft', { timeout: 30_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport);
    // Four words sent: the fourth waits for what follows it.
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change:");
    // Claude's words take the writing dots' place, in its serif, and nothing it drafted shows yet. A
    // screen reader hears "Claude is writing" until the final answer, which it hears once.
    const writing = panel.getByRole('status').filter({ hasText: 'Claude is writing' });
    await expect.element(writing, { timeout: 4_000 }).toBeInTheDocument();
    expect(writing.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(growing(panel)?.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(growing(panel)!.querySelector('p')!).fontFamily).toContain('Source Serif 4');
    // Drawn as Markdown, in the same frame as the final answer's prose, so the swap moves nothing.
    expect(growing(panel)!.querySelector('.cd-claude-message__prose > .cd-md')).not.toBeNull();
    expect(panel.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
    expectNoHorizontalScroll();
    await expectScreenBasics(document.body, { owner: true });

    held.release();
    await expect.element(panel.getByRole('button', { name: 'Confirm change' }), { timeout: 4_000 }).toBeVisible();
    // The saved answer takes the growing one's place: its words once, whole.
    expect(growing(panel)).toBeNull();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(1);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('takes_typing_while_the_answer_streams_and_sends_it_once_the_answer_ends', { timeout: 80_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change:");
    // The panel's composer has focus as the answer streams, and keeps it: typing works, Send waits.
    const box = panel.getByRole('textbox', { name: 'Ask Claude' });
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    await expect.element(box, { timeout: 4_000 }).toHaveFocus();
    await expect.element(box, { timeout: 4_000 }).toBeEnabled();
    await userEvent.keyboard('And on holidays?');
    await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
    await expect.element(send, { timeout: 4_000 }).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
    expect(requests('ruleChat')).toHaveLength(1);

    held.release();
    await finalAnswer(panel, 'Nothing changes until you confirm it.');
    // The answer has come in: the words typed meanwhile are still there, with focus, and they send.
    await expect.element(box, { timeout: 4_000 }).toHaveFocus();
    await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
    await expect.element(send, { timeout: 4_000 }).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('ruleChat'), { timeout: 4_000 }).toHaveLength(2);
    await expect.element(box, { timeout: 4_000 }).toHaveValue('');
  });

  it('keeps_the_writing_dots_until_a_word_is_whole', { timeout: 25_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 1, until: held.until });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByRole('status').filter({ hasText: 'Claude is writing' }), { timeout: 4_000 }).toBeInTheDocument();
    // The first word alone could still be cut off, so nothing shows of it yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(growing(panel)).toBeNull();
    expect(panel.element().querySelector('.cd-writing-indicator')).not.toBeNull();
    held.release();
    await expect.element(panel.getByText(ANSWER, { exact: true }), { timeout: 4_000 }).toBeVisible();
  });

  it('starts_the_answer_again_on_a_reset', { timeout: 25_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { resetAfter: 3, pauseAfter: 5, until: held.until });
    const { panel } = await ask(viewport);
    // Three words, then a reset, then the first two again, the second waiting for what follows it.
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's");
    expect(panel.getByText("Here's that change:", { exact: false }).elements()).toHaveLength(0);
    held.release();
    await expect.element(panel.getByText(ANSWER, { exact: true }), { timeout: 4_000 }).toBeVisible();
  });

  it('says_why_when_the_stream_fails_as_the_json_answer_would', async () => {
    mockStore.planStream('ruleChat', { fail: { status: 409, error: 'rules_cannot_be_checked' }, failAfter: 2 });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByText(RULES_UNAVAILABLE_COPY, { exact: true }), { timeout: 4_000 }).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('says_what_the_json_answer_would_for_a_limit_not_set_and_an_unexpected_failure', { timeout: 25_000 }, async () => {
    mockStore.planStream('ruleChat', { fail: { status: 422, error: 'above_money_cap', cap_cents: 0 }, failAfter: 2 });
    const { screen, panel } = await ask(viewport);
    await expect.element(panel.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true }), { timeout: 4_000 }).toBeVisible();
    expect(growing(panel)).toBeNull();
    mockStore.planStream('ruleChat', { fail: { status: 500, error: 'internal' }, failAfter: 1 });
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill(ASK);
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByText(DRAFT_FAILED, { exact: true }), { timeout: 4_000 }).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(requests('ruleChat')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
  });

  it.each([
    { cap: null, line: "That's above your limit of $500. Raise the limit first." },
    { cap: 0, line: "You haven't set a limit for taking money without asking. Set one first." },
  ])('refuses_a_money_rule_over_the_limit_after_its_answer_streamed_with_cap_$cap', { timeout: 25_000 }, async ({ cap, line }) => {
    if (cap !== null) mockStore.world.desk(RIVERA.deskId)!.policy.auto_money_cap_cents = cap;
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport, PAYMENT_LINKS);
    // The answer streams first: the limit is checked once the change is drafted, after it.
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change:");
    held.release();
    await expect.element(panel.getByText(line, { exact: true }), { timeout: 4_000 }).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(panel.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('asks_again_as_json_when_the_stream_breaks_off', async () => {
    mockStore.planStream('ruleChat', { dropAfter: 2 });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByRole('button', { name: 'Confirm change' }), { timeout: 4_000 }).toBeVisible();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(1);
    expect(requests('ruleChat')).toHaveLength(2);
  });

  it('shows_a_refusal_before_any_stream_as_today', async () => {
    mockStore.inject({ route: 'ruleChat', status: 422, body: { error: 'above_money_cap', cap_cents: 50_000 } });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByText('$500', { exact: false }), { timeout: 4_000 }).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('asks_nothing_it_had_queued_once_the_desk_closes', { timeout: 25_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 2, until: held.until });
    const { screen, panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's");
    // A second question waits behind the first.
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill('Why?');
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByText('Why?', { exact: true }), { timeout: 4_000 }).toBeVisible();
    // The owner leaves the Desk while the first answer is written.
    await screen.unmount();
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('leaves_the_owner_where_they_scrolled_while_the_answer_grows', { timeout: 75_000 }, async () => {
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    const words = growingWords(long);
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    const first = gate();
    const second = gate();
    mockStore.planStream('ruleChat', { holds: [{ after: 400, until: first.until }, { after: 410, until: second.until }] });
    const { panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[399] ?? ''));
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200);
    // The owner scrolls down the answer to read on.
    log.scrollTop += 120;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const read = log.scrollTop;
    first.release();
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[409] ?? ''));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // More of the answer came; the owner is still where they scrolled to.
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
    second.release();
    await finalAnswer(panel, 'Part 30 of the answer');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // The final answer takes the growing one's place; the owner is still where they scrolled to.
    expect(growing(panel)).toBeNull();
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
  });

  it('leaves_the_owner_where_they_scroll_in_the_same_frame_as_new_words', { timeout: 75_000 }, async () => {
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    const words = growingWords(long);
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    const first = gate();
    const second = gate();
    mockStore.planStream('ruleChat', { holds: [{ after: 400, until: first.until }, { after: 410, until: second.until }] });
    const { panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[399] ?? ''));
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200);
    // Keep the scroll event pending until growth effects have run, arranging the rendering-step
    // race without relying on the machine's frame timing. The scroll itself is real.
    const deferScroll = (event: Event) => event.stopImmediatePropagation();
    log.addEventListener('scroll', deferScroll, { capture: true });
    log.scrollTop += 120;
    const read = log.scrollTop;
    first.release();
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[409] ?? ''));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    log.removeEventListener('scroll', deferScroll, { capture: true });
    log.dispatchEvent(new Event('scroll'));
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
    second.release();
    await finalAnswer(panel, 'Part 30 of the answer');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(growing(panel)).toBeNull();
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
  });

  it('leaves_the_owner_where_they_scroll_up_in_the_same_frame_as_new_words', { timeout: 95_000 }, async () => {
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    mockStore.planStream('ruleChat', { quiet: true });
    const { panel } = await ask(viewport);
    await finalAnswer(panel, 'Part 30 of the answer');
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);

    const followUp = long.replaceAll('Part ', 'More ');
    const words = growingWords(followUp);
    const first = gate();
    const second = gate();
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: followUp, draft: null } });
    mockStore.planStream('ruleChat', { holds: [{ after: 400, until: first.until }, { after: 410, until: second.until }] });
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill('Why?');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[399] ?? ''));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(log.scrollTop).toBeGreaterThanOrEqual(120);
    // Defer the owner's real scroll event through growth effects. Moving up leaves room for
    // revealExchange to move down again unless it notices the pending owner movement first.
    const deferScroll = (event: Event) => event.stopImmediatePropagation();
    log.addEventListener('scroll', deferScroll, { capture: true });
    log.scrollTop -= 120;
    const read = log.scrollTop;
    first.release();
    await expect.poll(() => growing(panel)?.textContent, LANDS_WITHIN).toBe(settledWords(words[409] ?? ''));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    log.removeEventListener('scroll', deferScroll, { capture: true });
    log.dispatchEvent(new Event('scroll'));
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
    second.release();
    await finalAnswer(panel, 'More 30 of the answer');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(growing(panel)).toBeNull();
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
  });

  it('follows_a_follow_up_answer_once_the_conversation_overflows', { timeout: 75_000 }, async () => {
    // A first answer long enough that the conversation scrolls.
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    // It comes whole, with no growing words: it is only there to make the conversation scroll.
    mockStore.planStream('ruleChat', { quiet: true });
    const { panel } = await ask(viewport);
    await finalAnswer(panel, 'Part 30 of the answer');
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
    // A follow-up: Claude brings the owner's new question into view, then follows its answer.
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 12, until: held.until });
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill('Why?');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => (growing(panel)?.textContent ?? '').split(' ').length, LANDS_WITHIN).toBe(11);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const inView = (el: Element) => el.getBoundingClientRect().bottom <= log.getBoundingClientRect().bottom + 1;
    // Followed with room under it, as a chat leaves its end: 24 px above the conversation's foot.
    const roomUnder = (el: Element) => log.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    expect(inView(growing(panel)!)).toBe(true);
    expect(Math.abs(roomUnder(growing(panel)!) - 24), `${roomUnder(growing(panel)!)} px under the answer being written`).toBeLessThanOrEqual(2);
    held.release();
    const final = await finalAnswer(panel, 'I can explain what a rule does, or draft a change to one.');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(inView(final)).toBe(true);
    expect(Math.abs(roomUnder(final) - 24), `${roomUnder(final)} px under the final answer`).toBeLessThanOrEqual(2);
  });

  it('shows_a_drafted_change_with_both_its_buttons_in_view', async () => {
    const { panel } = await ask(viewport);
    await expect.element(panel.getByRole('button', { name: 'Confirm change' }), { timeout: 4_000 }).toBeVisible();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    const inLog = (el: Element) => {
      const box = el.getBoundingClientRect();
      const port = log.getBoundingClientRect();
      return box.top >= port.top - 1 && box.bottom <= port.bottom + 1;
    };
    // The one action that applies the change is never left under the fold.
    for (const name of ['Confirm change', 'Keep my rules']) expect(inLog(panel.getByRole('button', { name }).element()), name).toBe(true);
    // The owner's words stay in view too when both fit; when they don't, the buttons win.
    const words = panel.getByText(ASK, { exact: true }).element();
    const keep = panel.getByRole('button', { name: 'Keep my rules' }).element();
    if (keep.getBoundingClientRect().bottom - words.getBoundingClientRect().top <= log.clientHeight) expect(inLog(words)).toBe(true);
  });

  it('keeps_the_owners_place_when_they_scrolled_before_the_draft_landed', { timeout: 45_000 }, async () => {
    // A first answer long enough that the conversation scrolls.
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    mockStore.planStream('ruleChat', { quiet: true });
    const { panel } = await ask(viewport, 'How do quotes work?');
    await finalAnswer(panel, 'Part 30 of the answer');
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    // Then a change, which the owner scrolls away from while its answer is written.
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 6, until: held.until });
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill(ASK);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change: quotes stay");
    log.scrollTop -= 150;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const read = log.scrollTop;
    held.release();
    await expect.element(panel.getByRole('button', { name: 'Confirm change' }), { timeout: 4_000 }).toBeInTheDocument();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
  });

  it('closes_the_stream_with_the_panel', { timeout: 30_000 }, async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 2, until: held.until });
    const { screen, panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's");
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect.element(panel, { timeout: 4_000 }).not.toBeInTheDocument();
    held.release();
    // Asked again, the new conversation holds only its own exchange.
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await composer.fill('Why?');
    await userEvent.keyboard('{Enter}');
    const again = viewport === 'phone' ? screen.getByRole('dialog', { name: 'Ask Claude' }) : screen.getByRole('complementary', { name: 'Ask Claude' });
    const explained = 'I can explain what a rule does, or draft a change to one. Ask about a tool by name, such as quotes, bookings or refunds.';
    await expect.element(again.getByText(explained, { exact: true }), { timeout: 4_000 }).toBeVisible();
    await expect.poll(() => growing(again), { timeout: 4_000 }).toBeNull();
    expect(again.getByText(ANSWER, { exact: true }).elements()).toHaveLength(0);
    expect(again.getByText(ASK, { exact: true }).elements()).toHaveLength(0);
  });
});

// Beside the panel, the Rules page's own composer stays in reach; on a phone the sheet covers it.
it('holds_the_rules_page_composer_while_an_answer_streams_and_sends_once_it_has_come_in', { timeout: 70_000 }, async () => {
  const held = gate();
  mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
  const { screen, panel } = await ask('desktop');
  await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change:");
  // The page's box takes typing and keeps focus while the answer streams; only Send and Enter wait.
  const box = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
  const send = () => box.element().closest('.cd-composer')!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await box.click();
  await userEvent.keyboard('And on holidays?');
  await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
  await expect.element(box, { timeout: 4_000 }).toHaveFocus();
  expect(send().disabled).toBe(true);
  await userEvent.keyboard('{Enter}');
  await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
  expect(requests('ruleChat')).toHaveLength(1);

  held.release();
  await finalAnswer(panel, 'Nothing changes until you confirm it.');
  // The answer has come in: the words are still there, with focus, and they send.
  await expect.element(box, { timeout: 4_000 }).toHaveFocus();
  await expect.element(box, { timeout: 4_000 }).toHaveValue('And on holidays?');
  await expect.poll(() => send().disabled, { timeout: 4_000 }).toBe(false);
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => requests('ruleChat'), { timeout: 4_000 }).toHaveLength(2);
  await expect.element(box, { timeout: 4_000 }).toHaveValue('');
});

it('holds_the_rules_page_suggestions_while_an_answer_streams_and_asks_once_it_has_come_in', { timeout: 55_000 }, async () => {
  const held = gate();
  mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
  const { screen, panel } = await ask('desktop');
  await expect.poll(() => growing(panel)?.textContent, { timeout: 4_000 }).toBe("Here's that change:");
  // A suggestion waits, in its place, while the answer comes in: a press asks nothing.
  const chip = screen.getByRole('group', { name: 'Suggestions' }).getByRole('button').first();
  await expect.element(chip, { timeout: 4_000 }).toBeVisible();
  await expect.element(chip, { timeout: 4_000 }).toBeDisabled();
  (chip.element() as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(requests('ruleChat')).toHaveLength(1);

  held.release();
  await finalAnswer(panel, 'Nothing changes until you confirm it.');
  await expect.element(chip, { timeout: 4_000 }).toBeEnabled();
  await chip.click();
  await expect.poll(() => requests('ruleChat'), { timeout: 4_000 }).toHaveLength(2);
});
