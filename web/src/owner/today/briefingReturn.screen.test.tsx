import { expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { observeRequests } from '../../api/http.ts';
import { ROUTES } from '../../api/routes.ts';
import { matchRule } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { holdReads } from '../../test/holdReads.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { focusIsOn, nextFrames } from '../../test/screen.ts';

const TODAY = `/app/${RIVERA.deskId}/today`;

async function waitForRequestLanding(screen: RenderResult, reason: string) {
  const card = screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
  await expect.element(card).toBeInTheDocument();
  await expect.poll(() => focusIsOn(card.element())).toBe(true);
}

it('waits for request focus when the body already contains the request', async () => {
  const held = [...mockStore.world.decisions.values()].find(({ decision }) => decision.state === 'held')!.decision;
  const { screen } = await renderRoute(TODAY);
  const card = screen.getByRole('article', { name: `Held for you: ${held.reason_plain}`, exact: true });
  await expect.element(card).toBeVisible();
  expect(document.activeElement).toBe(document.body);
  expect(document.body.textContent).toContain(held.reason_plain);
  let landed = false;
  const landing = waitForRequestLanding(screen, held.reason_plain).then(() => { landed = true; });
  // The request is drawn, but its landing has not run. The helper must keep waiting.
  await nextFrames();
  const landedOnBody = landed;
  card.element().parentElement!.focus();
  await landing;
  expect(landedOnBody).toBe(false);
});

it.each(['request', '#needs-you'])('keeps the owner\'s focus after a later Needs you read at %s', async (hash) => {
  const held = [...mockStore.world.decisions.values()].find(({ decision }) => decision.state === 'held')!.decision;
  const landing = hash === 'request' ? `#request-${held.decision_id}` : hash;
  const { screen } = await renderRoute(`${TODAY}${landing}`);
  await expect.element(screen.getByRole('region', { name: 'Needs you', exact: true })).toBeInTheDocument();
  const target = hash === 'request'
    ? screen.getByRole('article', { name: `Held for you: ${held.reason_plain}`, exact: true }).element().parentElement!
    : screen.getByRole('region', { name: 'Needs you', exact: true }).element();
  await expect.element(target).toHaveFocus();
  const read = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  await expect.poll(read.held).toBeGreaterThan(0);
  const other = screen.getByRole('button', { name: 'Copy your Desk link' });
  other.element().focus();
  const answered = new Promise<void>((resolve) => {
    const stop = observeRequests((outcome) => {
      if (outcome.key !== 'needsYou') return;
      stop();
      resolve();
    });
    onTestFinished(stop);
  });
  read.release();
  await answered;
  await nextFrames();
  await expect.element(other).toHaveFocus();
});

async function openBriefing(hash = '') {
  const world = mockStore.world;
  const desk = world.desk(RIVERA.deskId)!;
  const text = 'Do you work in Alameda?';
  world.replay(world.addSession(desk), world.now() - 10 * MINUTE, [{ text, steps: matchRule(text).steps }]);
  const held = [...world.decisions.values()].find(({ decision }) => decision.state === 'held')!.decision;
  const landing = hash === 'request' ? `#request-${held.decision_id}` : hash;
  const view = await renderRoute(`${TODAY}${landing}`, { viewport: { width: 1440, height: 900 } });
  if (landing === '#needs-you') {
    await expect.element(view.screen.getByRole('region', { name: 'Needs you', exact: true })).toHaveFocus();
  } else if (hash === 'request') {
    await waitForRequestLanding(view.screen, held.reason_plain);
  }
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

it.each(['#needs-you', 'request'])('restores the briefing opener after browser Back to a %s entry', async (hash) => {
  const { router, seeAll, main, top } = await openBriefing(hash);
  await router.navigate(-1);
  await expect.element(seeAll).toBeInTheDocument();
  await expect.element(seeAll).toHaveFocus();
  await expect.poll(() => main.scrollTop).toBe(top);
});

it.each(['#needs-you', 'request'])('restores the briefing opener through Back to Today to a %s entry', async (hash) => {
  const { screen, seeAll, main, top } = await openBriefing(hash);
  await screen.getByRole('link', { name: 'Back to Today', exact: true }).click();
  await expect.element(seeAll).toBeInTheDocument();
  await expect.element(seeAll).toHaveFocus();
  await expect.poll(() => main.scrollTop).toBe(top);
});
