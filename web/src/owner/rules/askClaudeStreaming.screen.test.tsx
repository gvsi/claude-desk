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
  await expect.element(composer).toBeVisible();
  await composer.fill(words);
  await userEvent.keyboard('{Enter}');
  // Beside the page it is a complementary panel; at 390 px, a full sheet over it.
  const panel = viewport === 'phone' ? screen.getByRole('dialog', { name: 'Ask Claude' }) : screen.getByRole('complementary', { name: 'Ask Claude' });
  await expect.element(panel).toBeVisible();
  return { screen, panel };
}

/** The answer growing in the panel, or null. */
const growing = (panel: { element(): Element }) => panel.element().querySelector<HTMLElement>('.cd-rule-chat__growing');

describe.each(['desktop', 'phone'] as const)('Ask Claude streaming at %s', (viewport) => {
  it('grows_the_answer_then_shows_the_final_draft', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport);
    // Four words sent: the fourth waits for what follows it.
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's that change:");
    // Claude's words take the writing dots' place, in its serif, and nothing it drafted shows yet. A
    // screen reader hears "Claude is writing" until the final answer, which it hears once.
    const writing = panel.getByRole('status').filter({ hasText: 'Claude is writing' });
    await expect.element(writing).toBeInTheDocument();
    expect(writing.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(growing(panel)?.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(growing(panel)!.querySelector('p')!).fontFamily).toContain('Source Serif 4');
    expect(panel.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
    expectNoHorizontalScroll();
    await expectScreenBasics(document.body, { owner: true });

    held.release();
    await expect.element(panel.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    // The saved answer takes the growing one's place: its words once, whole.
    expect(growing(panel)).toBeNull();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(1);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('keeps_the_writing_dots_until_a_word_is_whole', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 1, until: held.until });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByRole('status').filter({ hasText: 'Claude is writing' })).toBeInTheDocument();
    // The first word alone could still be cut off, so nothing shows of it yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(growing(panel)).toBeNull();
    expect(panel.element().querySelector('.cd-writing-indicator')).not.toBeNull();
    held.release();
    await expect.element(panel.getByText(ANSWER, { exact: true })).toBeVisible();
  });

  it('starts_the_answer_again_on_a_reset', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { resetAfter: 3, pauseAfter: 5, until: held.until });
    const { panel } = await ask(viewport);
    // Three words, then a reset, then the first two again, the second waiting for what follows it.
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's");
    expect(panel.getByText("Here's that change:", { exact: false }).elements()).toHaveLength(0);
    held.release();
    await expect.element(panel.getByText(ANSWER, { exact: true })).toBeVisible();
  });

  it('says_why_when_the_stream_fails_as_the_json_answer_would', async () => {
    mockStore.planStream('ruleChat', { fail: { status: 409, error: 'rules_cannot_be_checked' }, failAfter: 2 });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByText(RULES_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('says_what_the_json_answer_would_for_a_limit_not_set_and_an_unexpected_failure', async () => {
    mockStore.planStream('ruleChat', { fail: { status: 422, error: 'above_money_cap', cap_cents: 0 }, failAfter: 2 });
    const { screen, panel } = await ask(viewport);
    await expect.element(panel.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true })).toBeVisible();
    expect(growing(panel)).toBeNull();
    mockStore.planStream('ruleChat', { fail: { status: 500, error: 'internal' }, failAfter: 1 });
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill(ASK);
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByText(DRAFT_FAILED, { exact: true })).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(requests('ruleChat')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
  });

  it.each([
    { cap: null, line: "That's above your limit of $500. Raise the limit first." },
    { cap: 0, line: "You haven't set a limit for taking money without asking. Set one first." },
  ])('refuses_a_money_rule_over_the_limit_after_its_answer_streamed_with_cap_$cap', async ({ cap, line }) => {
    if (cap !== null) mockStore.world.desk(RIVERA.deskId)!.policy.auto_money_cap_cents = cap;
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport, PAYMENT_LINKS);
    // The answer streams first: the limit is checked once the change is drafted, after it.
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's that change:");
    held.release();
    await expect.element(panel.getByText(line, { exact: true })).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(panel.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('asks_again_as_json_when_the_stream_breaks_off', async () => {
    mockStore.planStream('ruleChat', { dropAfter: 2 });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    expect(panel.getByText(ANSWER, { exact: true }).elements()).toHaveLength(1);
    expect(requests('ruleChat')).toHaveLength(2);
  });

  it('shows_a_refusal_before_any_stream_as_today', async () => {
    mockStore.inject({ route: 'ruleChat', status: 422, body: { error: 'above_money_cap', cap_cents: 50_000 } });
    const { panel } = await ask(viewport);
    await expect.element(panel.getByText('$500', { exact: false })).toBeVisible();
    expect(growing(panel)).toBeNull();
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('asks_nothing_it_had_queued_once_the_desk_closes', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 2, until: held.until });
    const { screen, panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's");
    // A second question waits behind the first.
    await panel.getByRole('textbox', { name: 'Ask Claude' }).fill('Why?');
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByText('Why?', { exact: true })).toBeVisible();
    // The owner leaves the Desk while the first answer is written.
    await screen.unmount();
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('ruleChat')).toHaveLength(1);
  });

  it('leaves_the_owner_where_they_scrolled_while_the_answer_grows', async () => {
    const long = Array.from({ length: 30 }, (_, n) => `Part ${n + 1} of the answer explains one more thing about how quotes work on weekdays.`).join(' ');
    const words = growingWords(long);
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer: long, draft: null } });
    const first = gate();
    const second = gate();
    mockStore.planStream('ruleChat', { holds: [{ after: 400, until: first.until }, { after: 410, until: second.until }] });
    const { panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent, { timeout: 5_000 }).toBe(settledWords(words[399] ?? ''));
    const log = panel.element().querySelector<HTMLElement>('[role="log"]')!;
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200);
    // The owner scrolls down the answer to read on.
    log.scrollTop += 120;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const read = log.scrollTop;
    first.release();
    await expect.poll(() => growing(panel)?.textContent, { timeout: 5_000 }).toBe(settledWords(words[409] ?? ''));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // More of the answer came; the owner is still where they scrolled to.
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
    second.release();
    await expect.element(panel.getByText(long, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // The final answer takes the growing one's place; the owner is still where they scrolled to.
    expect(growing(panel)).toBeNull();
    expect(Math.abs(log.scrollTop - read)).toBeLessThanOrEqual(1);
  });

  it('closes_the_stream_with_the_panel', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 2, until: held.until });
    const { screen, panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's");
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect.element(panel).not.toBeInTheDocument();
    held.release();
    // Asked again, the new conversation holds only its own exchange.
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await composer.fill('Why?');
    await userEvent.keyboard('{Enter}');
    const again = viewport === 'phone' ? screen.getByRole('dialog', { name: 'Ask Claude' }) : screen.getByRole('complementary', { name: 'Ask Claude' });
    const explained = 'I can explain what a rule does, or draft a change to one. Ask about a tool by name, such as quotes, bookings or refunds.';
    await expect.element(again.getByText(explained, { exact: true })).toBeVisible();
    await expect.poll(() => growing(again)).toBeNull();
    expect(again.getByText(ANSWER, { exact: true }).elements()).toHaveLength(0);
    expect(again.getByText(ASK, { exact: true }).elements()).toHaveLength(0);
  });
});
