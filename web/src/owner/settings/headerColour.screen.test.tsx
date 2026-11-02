import { http, HttpResponse, type JsonBodyType } from 'msw';
import { expect, it, onTestFinished } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';

import { ROUTES } from '../../api/routes.ts';
import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../ds/test/touch.ts';
import { worker } from '../../mocks/browser.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { mockDrain } from '../../test/mockDrain.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { BRAND_PALETTE, PALETTE_KEYS } from '../../public/palette.ts';

const GENERAL = `/app/${RIVERA.deskId}/profile`;

it('keeps swatches enabled and stores the latest quick pick after a slow earlier save', async () => {
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  mockStore.inject({ route: 'setBusiness', status: 200, afterCommit: true, until });
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'setBusiness').length).toBe(1);
  for (const radio of group.getByRole('radio').elements()) {
    expect(radio.hasAttribute('disabled')).toBe(false);
    expect(radio.getAttribute('aria-disabled')).not.toBe('true');
  }
  await expect.element(group).not.toHaveAttribute('aria-busy', 'true');
  await group.getByRole('radio', { name: 'Navy', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Navy', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(getComputedStyle(card.element().querySelector('.cd-header-colour__preview')!).backgroundColor).toBe('rgb(31, 58, 92)');
  release();
  await expect.poll(() => mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'navy' });
  await expect.element(group.getByRole('radio', { name: 'Navy', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
});

it.each([200, 422, 500])('ignores a superseded save response (%s) while the latest keyboard pick saves', async (status) => {
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseLast!: () => void;
  const last = new Promise<void>((resolve) => { releaseLast = resolve; });
  onTestFinished(() => { releaseFirst(); releaseLast(); });
  let received = false;
  worker.use(http.put(ROUTES.setBusiness.path.replace('{desk_id}', ':desk_id'), async ({ request, cookies }) => {
    if (received) return undefined;
    received = true;
    mockStore.inject({ route: 'setBusiness', status, afterCommit: status === 200 });
    const answer = await mockStore.dispatch('setBusiness', {
      params: { desk_id: RIVERA.deskId }, body: await request.json(), cookies,
    });
    await first;
    if ('network' in answer) return HttpResponse.error();
    return HttpResponse.json(answer.body as JsonBodyType, { status: answer.status });
  }));
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'setBusiness').length).toBe(1);
  mockStore.inject({ route: 'setBusiness', status: 200, afterCommit: true, until: last });
  await userEvent.keyboard('{ArrowRight}');
  const navy = group.getByRole('radio', { name: 'Navy', exact: true });
  await expect.element(navy).toHaveFocus();
  await expect.element(navy).toHaveAttribute('aria-checked', 'true');
  releaseFirst();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'setBusiness').length).toBe(2);
  await expect.element(navy).toHaveAttribute('aria-checked', 'true');
  await expect.element(group).not.toHaveAttribute('aria-busy', 'true');
  expect(group.getByRole('radio').elements().every((radio) => !radio.hasAttribute('disabled') && radio.getAttribute('aria-disabled') !== 'true')).toBe(true);
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
  releaseLast();
  await mockDrain.waitForIdle();
  await expect.element(navy).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'navy' });
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
});

it.each([422, 500])('reverts only a failed final pick (%s) to the colour saved by the earlier pick', async (status) => {
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  mockStore.inject({ route: 'setBusiness', status: 200, afterCommit: true, until });
  mockStore.inject({ route: 'setBusiness', status });
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'setBusiness').length).toBe(1);
  await group.getByRole('radio', { name: 'Navy', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Navy', exact: true })).toHaveAttribute('aria-checked', 'true');
  release();
  await mockDrain.waitForIdle();
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.element(card.getByRole('alert')).toHaveTextContent("That didn't save, so your header is still Clay.");
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
  expect(mockStore.requests.filter(({ key }) => key === 'setBusiness')).toHaveLength(2);
});

it('picks a header colour immediately and saves the whole business', async () => {
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  await expect.element(card).toBeVisible();
  const group = card.getByRole('radiogroup', { name: 'Header colour' });
  expect(group.getByRole('radio').elements().map((radio) => radio.getAttribute('aria-label'))).toEqual([
    'No colour', 'Teal', 'Clay', 'Navy', 'Forest', 'Plum', 'Rust', 'Slate',
  ]);
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => mockStore.requests.filter((r) => r.key === 'setBusiness').map((r) => r.body)).toEqual([{
    name: 'Turner Plumbing', owner_display_name: 'Mike Turner', timezone: 'America/Los_Angeles',
    brand_palette: 'clay', brand: {},
  }]);
  await expect.poll(() => getComputedStyle(card.element().querySelector('.cd-header-colour__preview')!).backgroundColor).toBe('rgb(119, 54, 36)');
});

it('moves through the radio group with arrow keys, wrapping at both ends', async () => {
  const { screen } = await renderRoute(GENERAL);
  const group = screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  (group.getByRole('radio', { name: 'Teal', exact: true }).element() as HTMLElement).focus();
  for (const [key, name] of [['ArrowRight', 'Clay'], ['ArrowDown', 'Navy'], ['ArrowUp', 'Clay'], ['ArrowLeft', 'Teal'], ['ArrowLeft', 'No colour'], ['ArrowLeft', 'Slate'], ['ArrowRight', 'No colour']] as const) {
    await mockDrain.waitForIdle();
    await userEvent.keyboard(`{${key}}`);
    await expect.element(group.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.element(group.getByRole('radio', { name, exact: true })).toHaveFocus();
    expect(group.getByRole('radio').elements().filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
  }
});

it('restores the place on Profile when Back returns from another page', async () => {
  const { screen, router } = await renderRoute(GENERAL, { viewport: { width: 390, height: 600 } });
  await expect.element(screen.getByRole('region', { name: 'Header colour', exact: true })).toBeVisible();
  const main = screen.getByRole('main').element();
  const heard = new Promise((resolve) => main.addEventListener('scroll', resolve, { once: true }));
  main.scrollTop = 180;
  await heard;
  const place = main.scrollTop;
  expect(place).toBeGreaterThan(0);
  await router.navigate(`/app/${RIVERA.deskId}/rules`);
  await expect.element(screen.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();
  await router.navigate(-1);
  await expect.element(screen.getByRole('region', { name: 'Your business' })).toBeVisible();
  await expect.poll(() => main.scrollTop).toBe(place);
});

it('restores a failed pick with the previous colour named in the notice', async () => {
  const { screen } = await renderRoute(GENERAL);
  const group = screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status: 500, delayMs: 400 });
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.element(screen.getByRole('alert')).toHaveTextContent("That didn't save, so your header is still Teal.");
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => getComputedStyle(document.querySelector('.cd-header-colour__preview')!).backgroundColor).toBe('rgb(31, 78, 74)');
  await group.getByRole('radio', { name: 'No colour', exact: true }).click();
  await mockDrain.waitForIdle();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  mockStore.inject({ route: 'setBusiness', status: 500 });
  await group.getByRole('radio', { name: 'Teal', exact: true }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent("That didn't save, so your header is still No colour.");
  await expect.element(group.getByRole('radio', { name: 'No colour', exact: true })).toHaveAttribute('aria-checked', 'true');
});

it('fits all eight swatches on one phone line and uses the signed sizes', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    const { screen } = await renderRoute(GENERAL, { viewport });
    const group = screen.getByRole('radiogroup', { name: 'Header colour' });
    await expect.element(group).toBeVisible();
    const swatches = group.getByRole('radio').elements();
    const boxes = swatches.map((radio) => radio.getBoundingClientRect());
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
    expect(boxes.map((box) => [box.width, box.height])).toEqual(Array.from({ length: 8 }, () => viewport === 'phone' ? [28, 28] : [32, 32]));
    expect(getComputedStyle(group.element()).gap).toBe(viewport === 'phone' ? '10px' : '12px');
    expect(getComputedStyle(swatches[1]!).boxShadow).not.toBe('none');
    const card = screen.getByRole('region', { name: 'Header colour', exact: true }).element();
    const previous = screen.getByRole('region', { name: 'Your business' }).element();
    expect(Math.round(card.getBoundingClientRect().top - previous.getBoundingClientRect().bottom)).toBe(viewport === 'phone' ? 16 : 20);
    expect(screen.getByRole('main').getByRole('region', { name: 'Claude acts for you' }).query()).toBeNull();
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  }
});

it('shows the default for empty storage and leaves a legacy brand unselected', async () => {
  const { screen } = await renderRoute(GENERAL, { seed: 'rivera_no_brand' });
  expect(mockStore.world.desks[0]?.brand).toEqual({});
  const group = screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.world.desks[0]!.brand = { primary: '#222220', accent: '#B87333' };
  const legacy = await renderRoute(GENERAL);
  const radios = legacy.screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(legacy.screen.getByText('Custom colour', { exact: true })).toBeVisible();
  expect(radios.getByRole('radio').elements().every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
});

it('draws the public header in every picked palette, including No colour', async () => {
  for (const palette of PALETTE_KEYS) {
    expect(await mockStore.dispatch('setBusiness', {
      params: { desk_id: RIVERA.deskId },
      body: { name: 'Turner Plumbing', owner_display_name: 'Mike Turner', timezone: 'America/Los_Angeles', brand_palette: palette, brand: {} },
    })).toMatchObject({ status: 200 });
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport });
      await expect.element(screen.getByRole('heading', { name: 'Turner Plumbing', exact: true })).toBeVisible();
      const header = document.querySelector('.cd-public-shell__brand')!;
      const probe = document.createElement('div');
      const colors = BRAND_PALETTE[palette];
      probe.style.color = 'primary' in colors ? colors.primary : 'var(--bg-panel)';
      document.body.append(probe);
      expect(getComputedStyle(header).backgroundColor, `${palette} on ${viewport}`).toBe(getComputedStyle(probe).color);
      probe.style.color = 'accent' in colors ? colors.accent : 'var(--line-hairline)';
      expect(getComputedStyle(header).borderBottomColor, `${palette} accent on ${viewport}`).toBe(getComputedStyle(probe).color);
      probe.remove();
      expectNoHorizontalScroll();
    }
  }
});


it('previews the header in paper ink on an owner colour, and in the theme ink on the panel', async () => {
  const root = document.documentElement;
  onTestFinished(() => {
    delete root.dataset.theme;
  });
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  const preview = card.getByRole('group', { name: 'Header preview' }).element();
  /** The preview's ground, its names' ink, its second line's and the monogram's edge. */
  const inks = () => {
    const [name, line] = [...preview.querySelectorAll('.cd-header-colour__names p')];
    return {
      field: getComputedStyle(preview).backgroundColor,
      name: getComputedStyle(name as Element).color,
      line: getComputedStyle(line as Element).color,
      monogram: getComputedStyle(one(preview, '.cd-header-colour__monogram')).borderTopColor,
    };
  };
  // The owner's colour is dark in either theme, so its words are paper ink in both.
  const onTeal = { field: 'rgb(31, 78, 74)', name: 'rgba(250, 249, 245, 0.92)', line: 'rgba(250, 249, 245, 0.64)', monogram: 'rgba(250, 249, 245, 0.64)' };
  expect(inks()).toEqual(onTeal);
  root.dataset.theme = 'light';
  expect(inks()).toEqual(onTeal);

  // No colour lays the theme's panel under it, and the theme's own inks: paper ink in dark, dark ink in light.
  await group.getByRole('radio', { name: 'No colour', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'No colour', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(inks()).toEqual({ field: 'rgb(239, 236, 228)', name: 'rgba(28, 27, 25, 0.92)', line: 'rgba(28, 27, 25, 0.68)', monogram: 'rgba(28, 27, 25, 0.68)' });
  root.dataset.theme = 'dark';
  expect(inks()).toEqual({ field: 'rgb(34, 34, 32)', name: 'rgba(250, 249, 245, 0.92)', line: 'rgba(250, 249, 245, 0.64)', monogram: 'rgba(250, 249, 245, 0.64)' });
});

/** The one element under `parent` that matches `selector`. */
function one(parent: Element, selector: string): Element {
  const found = parent.querySelectorAll(selector);
  expect(found, selector).toHaveLength(1);
  return found[0] as Element;
}

it('turns the swatch edge warm on keyboard focus without changing the selected ring', async () => {
  const { screen } = await renderRoute(GENERAL);
  const teal = screen.getByRole('radio', { name: 'Teal', exact: true });
  await expect.element(teal).toHaveAttribute('aria-checked', 'true');
  const selectedRing = getComputedStyle(teal.element()).boxShadow;
  const box = teal.element().getBoundingClientRect().toJSON();
  await userEvent.keyboard('{Tab}');
  (teal.element() as HTMLElement).focus();
  expect(teal.element().matches(':focus-visible')).toBe(true);
  const probe = document.createElement('span');
  probe.style.color = 'var(--line-focus)';
  document.body.append(probe);
  try {
    // The swatch's own 1 px edge turns line-focus: no outline, the selected ring as it was, and the
    // swatch no bigger.
    const style = getComputedStyle(teal.element());
    expect([style.borderTopWidth, style.borderTopStyle, style.borderTopColor]).toEqual(['1px', 'solid', getComputedStyle(probe).color]);
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', selectedRing]);
    expect(teal.element().getBoundingClientRect().toJSON()).toEqual(box);
  } finally {
    probe.remove();
  }
});


it.each(['network', 500] as const)('reads back a committed pick when its save response is lost (%s)', async (status) => {
  const { screen } = await renderRoute(GENERAL);
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status, afterCommit: true });
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await mockDrain.waitForIdle();
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});


it('keeps an unconfirmed pick when the save response and reread both fail', async () => {
  const { screen } = await renderRoute(GENERAL, { retryScale: 0 });
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status: 'network', afterCommit: true });
  mockStore.inject({ route: 'desks', status: 'network', times: 10 });
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await mockDrain.waitForIdle();
  await expect.element(card.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});

it('retries the selected unconfirmed colour without duplicating an in-flight save', async () => {
  const { screen } = await renderRoute(GENERAL, { retryScale: 0 });
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  const clay = group.getByRole('radio', { name: 'Clay', exact: true });
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status: 'network' });
  let connected = false;
  worker.use(http.get(ROUTES.desks.path, () => connected ? undefined : HttpResponse.error()));
  await clay.click();
  await mockDrain.waitForIdle();
  await expect.element(card.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
  await expect.element(clay).toHaveAttribute('aria-checked', 'true');

  connected = true;
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  let saving = false;
  worker.use(http.put(ROUTES.setBusiness.path.replace('{desk_id}', ':desk_id'), async () => {
    saving = true;
    await until;
    return undefined;
  }));
  await clay.click();
  await expect.poll(() => saving).toBe(true);
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
  // Repeating the current pick does not enqueue another write.
  await clay.click();
  release();
  await mockDrain.waitForIdle();
  await expect.element(clay).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.requests.filter(({ key }) => key === 'setBusiness')).toHaveLength(2);
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});

it('settles an unconfirmed pick after refocus reads the unchanged server colour and lets Clay retry', async () => {
  const { screen } = await renderRoute(GENERAL, { retryScale: 0 });
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  const teal = group.getByRole('radio', { name: 'Teal', exact: true });
  const clay = group.getByRole('radio', { name: 'Clay', exact: true });
  await expect.element(teal).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status: 'network' });
  let connected = false;
  let failedReads = 0;
  worker.use(http.get(ROUTES.desks.path, () => {
    if (connected) return undefined;
    failedReads += 1;
    return HttpResponse.error();
  }));
  await clay.click();
  await mockDrain.waitForIdle();
  await expect.element(card.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
  await expect.element(clay).toHaveAttribute('aria-checked', 'true');
  expect(failedReads).toBe(4); // Both readbacks, each with the query's one retry.
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'teal' });

  const reads = mockStore.requests.filter(({ key }) => key === 'desks').length;
  connected = true;
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'desks').length).toBeGreaterThan(reads);
  await expect.element(teal).toHaveAttribute('aria-checked', 'true');
  await expect.element(card.getByRole('alert')).not.toBeInTheDocument();
  await clay.click();
  await mockDrain.waitForIdle();
  await expect.element(clay).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.requests.filter(({ key }) => key === 'setBusiness')).toHaveLength(2);
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});


it('keeps the server pick when an earlier response returns after leaving and coming back', async () => {
  const { screen, router } = await renderRoute(GENERAL);
  const group = screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  let committed = false;
  let returned = false;
  worker.use(http.put(ROUTES.setBusiness.path.replace('{desk_id}', ':desk_id'), async ({ request, cookies }) => {
    if (committed) return undefined;
    const answer = await mockStore.dispatch('setBusiness', {
      params: { desk_id: RIVERA.deskId }, body: await request.json(), cookies,
    });
    committed = true;
    await until;
    returned = true;
    if ('network' in answer) return HttpResponse.error();
    return HttpResponse.json(answer.body as JsonBodyType, { status: answer.status });
  }));
  await group.getByRole('radio', { name: 'Navy', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await expect.element(group.getByRole('radio', { name: 'Navy', exact: true })).toHaveAttribute('aria-checked', 'true');
  // New picks stay interactive while their writes wait behind Navy.
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.requests.filter(({ key }) => key === 'setBusiness')).toHaveLength(1);
  await router.navigate(`/app/${RIVERA.deskId}/knowledge`);
  await expect.element(group).not.toBeInTheDocument();
  await router.navigate(GENERAL);
  await expect.element(group).toBeVisible();
  await group.getByRole('radio', { name: 'Plum', exact: true }).click();
  await expect.element(group.getByRole('radio', { name: 'Plum', exact: true })).toHaveAttribute('aria-checked', 'true');
  const reads = mockStore.requests.filter(({ key }) => key === 'desks').length;
  release();
  await expect.poll(() => returned).toBe(true);
  await mockDrain.waitForIdle();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'desks').length).toBeGreaterThan(reads);
  await expect.element(group.getByRole('radio', { name: 'Plum', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'plum' });
});

it('takes coarse-pointer taps 4 px outside every drawn phone swatch without overlapping', async () => {
  const { screen } = await renderRoute(GENERAL, { viewport: 'phone' });
  const group = screen.getByRole('radiogroup', { name: 'Header colour' });
  await expect.element(group).toBeVisible();
  group.element().scrollIntoView({ block: 'center' });
  const swatches = group.getByRole('radio').elements();
  const boxes = swatches.map((radio) => radio.getBoundingClientRect().toJSON());
  // No colour's slash must not share or clip the invisible hit area.
  expect(getComputedStyle(swatches[1]!, '::after').content).toBe('none');
  await coarsePointer();
  expect(swatches.map((radio) => radio.getBoundingClientRect().toJSON())).toEqual(boxes);
  for (const [index, swatch] of swatches.entries()) {
    const own = swatch.getBoundingClientRect();
    const area = hitArea(swatch);
    expect(area.height).toBe(44);
    expect(area.width).toBe(38); // 28 px plus half of each 10 px gap.
    expectHitAreaLands(swatch);
    expectUnseen(swatch);
    if (index > 0) expectApart(hitArea(swatches[index - 1]!), area, 'neighbouring swatches');
    await cdp().send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: own.right + 4, y: own.top + own.height / 2 }] });
    await cdp().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.element(group.getByRole('radio', { name: swatch.getAttribute('aria-label')!, exact: true })).toHaveAttribute('aria-checked', 'true');
    await mockDrain.waitForIdle();
  }
});


it('keeps a confirmed rollback when the settle read cannot reach the server', async () => {
  const { screen } = await renderRoute(GENERAL, { retryScale: 0 });
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  mockStore.inject({ route: 'setBusiness', status: 'network' });
  // The uncertain save's first read confirms Teal; only the subsequent settle read fails.
  let reads = 0;
  worker.use(http.get(ROUTES.desks.path, () => {
    reads += 1;
    return reads === 1 ? undefined : HttpResponse.error();
  }));
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await mockDrain.waitForIdle();
  await expect.element(card.getByRole('alert')).toHaveTextContent("That didn't save, so your header is still Teal.");
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(reads).toBeGreaterThan(1);
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'teal' });
});


it.each([false, true])('reads the stored colour after a superseded uncertain save and a rejected last pick (%s)', async (readWorks) => {
  const { screen } = await renderRoute(GENERAL, { retryScale: 0, pollScale: 100 });
  const card = screen.getByRole('region', { name: 'Header colour', exact: true });
  const group = card.getByRole('radiogroup');
  await expect.element(group.getByRole('radio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  mockStore.inject({ route: 'setBusiness', status: 'network', afterCommit: true, until });
  mockStore.inject({ route: 'setBusiness', status: 422 });
  // Even a working final read must not get Clay from the earlier settle refetch.
  let rejected = false;
  worker.use(http.put(ROUTES.setBusiness.path.replace('{desk_id}', ':desk_id'), async ({ request }) => {
    const body = await request.clone().json() as { brand_palette: string };
    if (body.brand_palette === 'navy') rejected = true;
    return undefined;
  }));
  worker.use(http.get(ROUTES.desks.path, () => readWorks && rejected ? undefined : HttpResponse.error()));
  await group.getByRole('radio', { name: 'Clay', exact: true }).click();
  await expect.poll(() => mockStore.requests.filter(({ key }) => key === 'setBusiness').length).toBe(1);
  await group.getByRole('radio', { name: 'Navy', exact: true }).click();
  release();
  await mockDrain.waitForIdle();
  await expect.element(card.getByRole('alert')).toHaveTextContent(readWorks
    ? "That didn't save, so your header is still Clay."
    : "We couldn't reach Claude Desk. Check your connection, then try again.");
  expect(card.getByText("That didn't save, so your header is still Teal.", { exact: true }).query()).toBeNull();
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});
