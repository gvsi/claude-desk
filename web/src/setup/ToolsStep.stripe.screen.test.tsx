/**
 * Stripe on setup's Tools step, from the CPA example. Once the setup chat has connected it, its two
 * tools are listed and none is on: Stripe reads "2 tools" and "Needs review" with a "Review" button
 * that opens their review and connects nothing again, never "Connect". A setup whose chat didn't
 * connect it still offers "Connect Stripe".
 */
import { expect, it } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { START_EXAMPLES } from './copy.ts';

/** The "A CPA firm in San Jose" example's description, as its chip fills it in. */
const CPA = START_EXAMPLES.en.examples.find(({ chip }) => chip === 'A CPA firm in San Jose')?.description ?? '';

/** The requests a route got, by key, from the `from`th request on. */
const requests = (key: string, from = 0) => mockStore.requests.slice(from).filter((r) => r.key === key);

/**
 * The CPA example's setup at Tools, the way the owner gets there: "Yes, use it", "Both, about
 * evenly", then "Use your suggestions", which accepts the chat's cards and connects Stripe. With
 * `declineStripe`, the owner turns Stripe's card down in the chat first, so nothing connects it.
 */
async function cpaAtTools({ declineStripe = false } = {}): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: CPA, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('The mock starts setup');
  const id = (started.body as SetupState).interview_id;
  const call = async (key: 'setupConsent' | 'setupAnswer' | 'setupProposal' | 'setupSuggestions', body: unknown, proposal_id?: string) => {
    const response = await mockStore.dispatch(key, { params: { id, ...(proposal_id ? { proposal_id } : {}) }, query: { cards: '1' }, body });
    if ('network' in response || response.status !== 200) throw new Error(`The mock takes ${key}`);
    return response.body as SetupState;
  };
  let state = await call('setupConsent', { allow: true });
  state = await call('setupAnswer', { question: state.question, text: 'Both, about evenly' });
  while (declineStripe && state.pending_card) {
    const card = state.messages.at(-1)?.card;
    if (!card) throw new Error('The pending card is the last message');
    const stripe = card.connector?.app === 'stripe';
    state = await call('setupProposal', { accept: !stripe && card.job?.job !== 'payment' }, card.proposal_id);
    if (stripe) break;
  }
  state = await call('setupSuggestions', {});
  if (state.step !== 'tools') throw new Error('Using the suggestions moves setup on to Tools');
  return state;
}

/** Stripe's row in "Connect your own". */
function stripeRow(screen: Awaited<ReturnType<typeof renderRoute>>['screen']) {
  return screen.getByRole('region', { name: 'Connect your own' }).getByRole('listitem').filter({ hasText: /^Stripe/ });
}

it.each([1440, 390])('at %i px, Stripe connected in the chat needs review, and Review opens its tools without connecting it again', async (width) => {
  const state = await cpaAtTools();
  const tools = mockStore.world.desk(state.desk_id)?.tools.filter(({ tool }) => tool.startsWith('payments.'));
  expect(tools?.map(({ status }) => status)).toEqual(['needs_review', 'needs_review']);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();

  const stripe = stripeRow(screen);
  await expect.element(stripe.getByText('2 tools', { exact: true })).toBeVisible();
  await expect.element(stripe.getByText('Needs review', { exact: true })).toBeVisible();
  expect(stripe.element().querySelector('.cd-setup-tools__job-status .cd-status-dot--held')).not.toBeNull();
  const review = stripe.getByRole('button', { name: 'Review Stripe', exact: true });
  await expect.element(review).toBeVisible();
  expect(screen.getByRole('button', { name: 'Connect Stripe' }).elements()).toHaveLength(0);
  expect(stripe.getByText('On', { exact: true }).elements()).toHaveLength(0);
  // Its count, its status and its button share one line, at 390 px as at 1440 px.
  const parts = ['.cd-setup-tools__count', '.cd-setup-tools__job-status', '.cd-button'].map((selector) => {
    const part = stripe.element().querySelector(`.cd-setup-tools__end ${selector}`);
    if (!part) throw new Error(`Stripe's row end has ${selector}`);
    const box = part.getBoundingClientRect();
    return box.top + box.height / 2;
  });
  for (const middle of parts) expect(Math.abs(middle - parts[0]!)).toBeLessThanOrEqual(1);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();

  const mark = mockStore.requests.length;
  await review.click();
  await expect.element(screen.getByRole('heading', { level: 1, name: /^Review what Claude could do with Stripe/ })).toBeVisible();
  const listed = screen.getByRole('region', { name: 'Tools' });
  await expect.element(listed.getByRole('list').getByText('See charges', { exact: true })).toBeVisible();
  await expect.element(listed.getByRole('list').getByText('Refund', { exact: true })).toBeVisible();
  const rules = screen.getByRole('region', { name: 'The rules that will cover them' });
  expect([...rules.element().querySelectorAll('.cd-rule-sentence__sentence')].map((el) => el.textContent)).toEqual([
    'Claude asks you before showing customers their own charges',
    'Claude asks you before any refund',
  ]);
  // No card covers either yet, so each starts at the ask Rules shows for it, for anyone, in Rules' words.
  expect([...rules.element().querySelectorAll('.cd-rule-sentence__meta')].map((el) => el.textContent)).toEqual([
    'See charges · Anyone', 'Refund · Anyone',
  ]);
  expect(rules.getByText('Ask me first', { exact: true }).elements()).toHaveLength(2);
  // Each tool's effects beside its title, as the signed review draws them.
  await expect.element(listed.getByText('Private data', { exact: true }).first()).toBeVisible();
  await expect.element(listed.getByText('Money', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Until you set a limit in Rules, every payment asks you first.', { exact: true })).toBeVisible();
  expect(requests('setupConnect', mark)).toHaveLength(0);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each([1440, 390])('at %i px, a setup whose chat did not connect Stripe still offers to connect it', async (width) => {
  const state = await cpaAtTools({ declineStripe: true });
  expect(mockStore.world.desk(state.desk_id)?.tools.some(({ tool }) => tool.startsWith('payments.'))).toBe(false);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();

  const stripe = stripeRow(screen);
  await expect.element(stripe.getByText('2 tools', { exact: true })).toBeVisible();
  await expect.element(stripe.getByRole('button', { name: 'Connect Stripe', exact: true })).toBeVisible();
  expect(stripe.getByText('Needs review', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Review Stripe' }).elements()).toHaveLength(0);
  expectNoHorizontalScroll();
});
