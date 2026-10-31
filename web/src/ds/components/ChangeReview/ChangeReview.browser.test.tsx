/**
 * ChangeReview's confirm when the screen's `onConfirm` throws before it sends anything. The press
 * is released, as every send-once button's is, so the owner can confirm again rather than facing a
 * button that waits forever. And a shared rule on a row with one side, which no story draws.
 */
import { composeStories } from '@storybook/react-vite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fn } from 'storybook/test';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { rivera } from '../../fixtures';
import type { ChangeRowView } from './ChangeReview.tsx';
import * as stories from './ChangeReview.stories.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const { TurnOnPayments } = composeStories(stories);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function confirmButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Confirm and turn on');
  if (!button) throw new Error('No confirm button');
  return button;
}

it('a_confirm_that_throws_releases_the_button', () => {
  const thrown = new Error('The screen could not send the confirm');
  // The story's own kind of mock, so it takes the place of the story's onConfirm.
  const onConfirm = fn().mockImplementation(() => {
    throw thrown;
  });
  // The throw leaves the click as an uncaught error, which the page reports: this test expects it.
  const reported: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    if (event.error !== thrown) return;
    reported.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  try {
    act(() => root.render(<TurnOnPayments onConfirm={onConfirm} />));
    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(reported.length).toBeGreaterThan(0);
    // Released: the button isn't busy, and the next press sends again.
    expect(confirmButton().getAttribute('aria-busy')).not.toBe('true');
    onConfirm.mockImplementation(() => undefined);
    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    // That press didn't throw, so it waits for its result: a third press sends nothing.
    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener('error', onError);
  }
});

it('a_removed_shared_rule_says_so_after_its_connector', () => {
  const card = rivera.sharedChargeCard;
  const removed: ChangeRowView = {
    key: card.card_id,
    change: 'removed',
    title: 'Payment link and Charge within a signed limit',
    connector: rivera.connectors.views.payments,
    shared: true,
    before: { mode: card.mode, limit: rivera.ruleLimits['rv-agent-charges'], reason: card.reason, words: rivera.ruleWords['rv-agent-charges'] },
    after: null,
    changed: [],
  };
  act(() => root.render(<TurnOnPayments rows={[removed]} />));
  const meta = container.querySelector('.cd-change-review__row > .cd-change-review__body > .cd-change-review__meta');
  expect(meta?.textContent).toBe("Payments · Shared rule · Alex Kim's assistant · Up to $20");
});
