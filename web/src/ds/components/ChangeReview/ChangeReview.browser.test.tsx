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

/** The meta line under a row's title. */
function rowMeta(): string | null | undefined {
  return container.querySelector('.cd-change-review__row > .cd-change-review__body > .cd-change-review__meta')?.textContent;
}

it('a_removed_shared_rule_says_so_after_its_connector', () => {
  const row = rivera.sharedChargeReviewRow;
  if (row.before === null) throw new Error('The shared row has no Before');
  const removed: ChangeRowView = { ...row, change: 'removed', before: { ...row.before, appliesTo: 'Every tool that charges money' }, after: null, changed: [] };
  act(() => root.render(<TurnOnPayments rows={[removed]} />));
  expect(rowMeta()).toBe("Payments · Shared rule · Every tool that charges money · Alex Kim's assistant · Up to $20");
});

it('a_shared_rule_on_tools_of_several_connectors_leads_with_shared_rule', () => {
  // Documents and Stripe's tools touch private data: no one connector has them all, so none is named.
  const added: ChangeRowView = {
    key: 'rv-private-verified',
    change: 'added',
    title: 'Every tool that touches private data',
    shared: true,
    before: null,
    after: {
      appliesTo: 'Every tool that touches private data',
      mode: 'auto',
      reason: "Customers see their own records after confirming it's them.",
      words: [{ field: 'who', text: "The record's owner, verified" }],
    },
    changed: [],
  };
  act(() => root.render(<TurnOnPayments rows={[added]} />));
  expect(rowMeta()).toBe("Shared rule · Every tool that touches private data · The record's owner, verified");
});
