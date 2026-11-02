import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { matchRule } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const TODAY = `/app/${RIVERA.deskId}/today`;

async function openBriefing() {
  const world = mockStore.world;
  const desk = world.desk(RIVERA.deskId)!;
  const text = 'Do you work in Alameda?';
  world.replay(world.addSession(desk), world.now() - 10 * MINUTE, [{ text, steps: matchRule(text).steps }]);
  const view = await renderRoute(TODAY, { viewport: { width: 1440, height: 900 } });
  const since = view.screen.getByRole('region', { name: 'Since last night', exact: true });
  const seeAll = since.getByRole('link', { name: /^See all/ });
  await expect.element(seeAll).toBeInTheDocument();
  seeAll.element().focus();
  await expect.element(seeAll).toHaveFocus();
  const main = document.querySelector('main')!;
  await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
  // Let the shell record the focus-induced scroll in this history entry.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const top = main.scrollTop;
  await userEvent.keyboard('{Enter}');
  await expect.element(view.screen.getByRole('heading', { level: 1, name: 'Since last night' })).toBeVisible();
  return { ...view, since, seeAll, main, top };
}

it('restores the briefing opener and scroll after browser Back at 1440 by 900', async () => {
  const { router, seeAll, main, top } = await openBriefing();
  await router.navigate(-1);
  await expect.element(seeAll).toBeInTheDocument();
  await expect.poll(() => main.scrollTop).toBe(top);
  await expect.element(seeAll).toHaveFocus();
  const beforeTab = main.scrollTop;
  await userEvent.tab();
  expect(main.scrollTop).toBe(beforeTab);
});

it('restores the briefing opener and scroll through Back to Today at 1440 by 900', async () => {
  const { screen, seeAll, main, top } = await openBriefing();
  const back = screen.getByRole('link', { name: 'Back to Today', exact: true });
  await expect.element(back).toBeVisible();
  back.element().focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(seeAll).toBeInTheDocument();
  await expect.poll(() => main.scrollTop).toBe(top);
  await expect.element(seeAll).toHaveFocus();
  const beforeTab = main.scrollTop;
  await userEvent.tab();
  expect(main.scrollTop).toBe(beforeTab);
});
