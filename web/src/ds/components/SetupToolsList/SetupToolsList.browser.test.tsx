/**
 * An app connected during setup whose tools are listed, none of them on yet: its row keeps the
 * connector's tile and words, and at its right says how many tools it brings, that they need the
 * owner's review, and a "Review" button named for the app, in the board's order and classes.
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { within } from 'storybook/test';
import { expect, it, vi } from 'vitest';

import { rivera } from '../../fixtures/index.ts';
import { SetupToolsList } from './SetupToolsList.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The end of Stripe's row on the signed board, once Stripe is connected and its two tools wait for review. */
const SIGNED_END = [
  '<span class="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">',
  '<span class="cd-setup-tools__count">2 tools</span>',
  '<span class="cd-setup-tools__job-status"><span class="cd-status-dot cd-status-dot--held" aria-hidden="true"></span>Needs review</span>',
  '<button class="cd-button cd-button--secondary cd-button--inline cd-type-control" type="button"><span class="cd-button__label"><span aria-hidden="true">Review</span><span class="cd-sr-only">Review Stripe</span></span></button>',
  '</span>',
].join('');

/** Renders `ui` into a fresh host on the page; the returned function takes it off again. */
function mount(ui: ReactElement): { host: HTMLDivElement; unmount: () => void } {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  host.style.width = '720px';
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('a_connected_app_waiting_for_review_draws_the_boards_row_end', () => {
  const onReview = vi.fn();
  const { host, unmount } = mount(
    <SetupToolsList builtIn={[]} external={[{ connector: rivera.connectors.views.stripe, state: 'needs_review', tools: 2, onReview }]} />,
  );
  try {
    const group = within(host).getByRole('list', { name: 'Connect your own' });
    const [row] = within(group).getAllByRole('listitem');
    if (!row) throw new Error('Stripe has its row');
    // An app's row, not a job's: the same tile and words, then where it stands.
    expect(row.className).toBe('cd-setup-tools__row');
    expect([...row.children].map((child) => child.className)).toEqual([
      'cd-connector-icon cd-connector-icon--section cd-connector-icon--brand',
      'cd-connector-summary',
      'cd-setup-tools__end cd-setup-tools__end--action cd-type-meta',
    ]);
    expect(row.querySelector('.cd-setup-tools__end')?.outerHTML).toBe(SIGNED_END);
    expect(row.querySelector('.cd-setup-tools__job-status .cd-status-dot')?.className).toBe('cd-status-dot cd-status-dot--held');
    // The only control, named for the app it reviews; nothing offers to connect it again.
    expect(within(host).getAllByRole('button').map((button) => button.textContent)).toEqual(['ReviewReview Stripe']);
    const review = within(row).getByRole('button', { name: 'Review Stripe' });
    expect(within(host).queryByRole('button', { name: 'Connect Stripe' })).toBeNull();
    act(() => review.click());
    expect(onReview).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
  }
});
