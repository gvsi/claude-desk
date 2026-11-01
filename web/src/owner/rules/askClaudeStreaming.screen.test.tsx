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
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute, type Viewport } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const RULES = `/app/${RIVERA.deskId}/rules`;
const ASK = 'Stop quoting on weekends';
const ANSWER = "Here's that change: quotes stay automatic on weekdays, and on weekends they wait for your answer. Nothing changes until you confirm it.";

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
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's that change: quotes");
    // Claude's words take the writing dots' place, in its serif, and nothing it drafted shows yet.
    expect(panel.element().querySelector('.cd-writing-indicator')).toBeNull();
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

  it('starts_the_answer_again_on_a_reset', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { resetAfter: 3, pauseAfter: 4, until: held.until });
    const { panel } = await ask(viewport);
    // Three words, then a reset, then the first word again.
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's");
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

  it('closes_the_stream_with_the_panel', async () => {
    const held = gate();
    mockStore.planStream('ruleChat', { pauseAfter: 2, until: held.until });
    const { screen, panel } = await ask(viewport);
    await expect.poll(() => growing(panel)?.textContent).toBe("Here's that");
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
