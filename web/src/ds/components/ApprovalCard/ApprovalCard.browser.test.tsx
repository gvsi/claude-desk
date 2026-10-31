/**
 * An answer landing under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The landing stories run with their plays, so their reduced-motion branches are the ones
 * checked: nothing crosses or eases, and the answered card draws at once in the commit that lands
 * it, with no outgoing layer and no height held for it.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import meta, { AlwaysLandsWithItsRule, AnswerLands, DenyLands } from './ApprovalCard.stories.tsx';

it('answer_lands_at_once_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  for (const story of [AnswerLands, DenyLands, AlwaysLandsWithItsRule]) {
    // Every commit while it lands: never an outgoing layer, never a height set on the card.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('.cd-approval-card__layer--leaving') !== null) seen.push('an outgoing layer');
      if (document.querySelector<HTMLElement>('.cd-approval-card')?.style.height) seen.push('a held height');
      if (document.querySelector('.cd-approval-card--settling') !== null) seen.push('a settle');
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    await composeStory(story, meta).run();
    observer.disconnect();
    expect(seen).toEqual([]);
    expect(document.querySelectorAll('.cd-approval-card__layer')).toHaveLength(1);
    expect(document.querySelector('article')?.getAnimations({ subtree: true })).toEqual([]);
  }
});
