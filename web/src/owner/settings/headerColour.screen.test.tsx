import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { BRAND_PALETTE, PALETTE_KEYS } from '../../public/palette.ts';

const GENERAL = `/app/${RIVERA.deskId}/settings/general`;

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
    name: 'Rivera Plumbing', owner_display_name: 'Maria Rivera', timezone: 'America/Los_Angeles',
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
    await expect.element(group).toHaveAttribute('aria-busy', 'false');
    await userEvent.keyboard(`{${key}}`);
    await expect.element(group.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.element(group.getByRole('radio', { name, exact: true })).toHaveFocus();
    expect(group.getByRole('radio').elements().filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
  }
});

it('restores the place on Settings when Back returns from another page', async () => {
  const { screen, router } = await renderRoute(GENERAL, { viewport: { width: 390, height: 600 } });
  await expect.element(screen.getByRole('region', { name: 'Delete this Desk' })).toBeVisible();
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
  await expect.element(group).toHaveAttribute('aria-busy', 'false');
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
    const next = screen.getByRole('main').getByRole('region', { name: 'Claude acts for you' }).element();
    expect(Math.round(card.getBoundingClientRect().top - previous.getBoundingClientRect().bottom)).toBe(viewport === 'phone' ? 16 : 20);
    expect(Math.round(next.getBoundingClientRect().top - card.getBoundingClientRect().bottom)).toBe(viewport === 'phone' ? 16 : 20);
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
      body: { name: 'Rivera Plumbing', owner_display_name: 'Maria Rivera', timezone: 'America/Los_Angeles', brand_palette: palette, brand: {} },
    })).toMatchObject({ status: 200 });
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport });
      await expect.element(screen.getByRole('heading', { name: 'Rivera Plumbing', exact: true })).toBeVisible();
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


it('uses the shared warm focus ring without changing the selected ring', async () => {
  const { screen } = await renderRoute(GENERAL);
  const teal = screen.getByRole('radio', { name: 'Teal', exact: true });
  await expect.element(teal).toHaveAttribute('aria-checked', 'true');
  const selectedRing = getComputedStyle(teal.element()).boxShadow;
  await userEvent.keyboard('{Tab}');
  (teal.element() as HTMLElement).focus();
  expect(teal.element().matches(':focus-visible')).toBe(true);
  const probe = document.createElement('span');
  probe.style.color = 'var(--ring-focus, var(--text-primary))';
  document.body.append(probe);
  try {
    expect(getComputedStyle(teal.element()).outlineColor).toBe(getComputedStyle(probe).color);
    expect(getComputedStyle(teal.element()).boxShadow).toBe(selectedRing);
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
  await expect.element(group).toHaveAttribute('aria-busy', 'false');
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
  await expect.element(group).toHaveAttribute('aria-busy', 'false');
  await expect.element(card.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
  await expect.element(group.getByRole('radio', { name: 'Clay', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(mockStore.world.desks[0]?.brand).toMatchObject({ palette: 'clay' });
});
