import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const GENERAL = `/app/${RIVERA.deskId}/settings/general`;
const changes = () => mockStore.requests.filter(({ key }) => key === 'setAnswering').map(({ body }) => body);

describe('Claude acts for you', () => {
  it('asks before either switch changes what Claude can do', async () => {
    const { screen } = await renderRoute(GENERAL, { strict: true });
    const switches = [
      screen.getByRole('complementary', { name: 'Claude Desk' }).getByRole('switch', { name: 'Claude acts for you' }),
      screen.getByRole('main').getByRole('switch', { name: 'Claude acts for you' }),
    ];

    for (const control of switches) {
      await expect.element(control).toHaveAccessibleDescription('Within your rules');
      await control.click();
      const off = screen.getByRole('dialog', { name: 'Take messages only?' });
      await expect.element(off).toHaveAccessibleDescription('Claude keeps replying to visitors and their agents, but only takes messages and callback requests. Everything else is handed to you.');
      await expect.element(off.getByRole('button', { name: 'Keep acting for me' })).toHaveFocus();
      await expect.element(control).toHaveAttribute('aria-checked', 'true');
      const before = changes();
      await userEvent.keyboard('{Escape}');
      await expect.element(off).not.toBeInTheDocument();
      await expect.element(control).toHaveFocus();
      expect(changes()).toEqual(before);

      // Both explicit cancellation and a browser close leave the setting alone.
      await control.click();
      await off.getByRole('button', { name: 'Keep acting for me' }).click();
      await expect.element(control).toHaveFocus();
      await control.click();
      (off.element() as HTMLDialogElement).close();
      await expect.element(off).not.toBeInTheDocument();
      await expect.element(control).toHaveFocus();
      expect(changes()).toEqual(before);

      await control.click();
      await off.getByRole('button', { name: 'Take messages only', exact: true }).click();
      await expect.element(control).toHaveFocus();
      for (const item of switches) {
        await expect.element(item).toHaveAttribute('aria-checked', 'false');
        await expect.element(item).toHaveAccessibleDescription('Taking messages only');
      }
      await expect.poll(changes).toEqual([...before, { on: false }]);
      await expect.poll(() => mockStore.world.desk(RIVERA.deskId)?.summary.answering).toBe(false);

      await control.click();
      const on = screen.getByRole('dialog', { name: 'Let Claude act for you again?' });
      await expect.element(on).toHaveAccessibleDescription('Claude can use your tools again, under your rules. Anything a rule holds still waits for you.');
      await expect.element(on.getByRole('button', { name: 'Not now' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      await expect.element(control).toHaveFocus();
      await expect.element(control).toHaveAttribute('aria-checked', 'false');
      expect(changes()).toEqual([...before, { on: false }]);
      await control.click();
      await on.getByRole('button', { name: 'Not now' }).click();
      await expect.element(control).toHaveFocus();
      await control.click();
      (on.element() as HTMLDialogElement).close();
      await expect.element(on).not.toBeInTheDocument();
      await expect.element(control).toHaveFocus();
      expect(changes()).toEqual([...before, { on: false }]);
      await control.click();
      await on.getByRole('button', { name: 'Let Claude act', exact: true }).click();
      await expect.element(control).toHaveFocus();
      await expect.poll(changes).toEqual([...before, { on: false }, { on: true }]);
      await expect.poll(() => mockStore.world.desk(RIVERA.deskId)?.summary.answering).toBe(true);
    }
  });

  it.each(['settings', 'sidebar'] as const)('keeps both dialogs on a phone inside the window, the safe choice first, from %s', async (source) => {
    const { screen } = await renderRoute(GENERAL, { viewport: 'phone' });
    if (source === 'sidebar') await screen.getByRole('button', { name: 'Menu', exact: true }).click();
    const area = source === 'sidebar' ? screen.getByRole('dialog', { name: 'Menu' }) : screen.getByRole('main');
    const control = area.getByRole('switch', { name: 'Claude acts for you' });
    await expect.element(control).toHaveAttribute('aria-checked', 'true');

    for (const [title, safeLabel, action, next] of [
      ['Take messages only?', 'Keep acting for me', 'Take messages only', false],
      ['Let Claude act for you again?', 'Not now', 'Let Claude act', true],
    ] as const) {
      await control.click();
      const dialog = screen.getByRole('dialog', { name: title });
      const safe = dialog.getByRole('button', { name: safeLabel });
      const confirm = dialog.getByRole('button', { name: action, exact: true });
      await expect.element(safe).toHaveFocus();
      // The design system's dialog as drawn: its actions row wraps by itself on a phone, the safe
      // choice first, so a pair too wide for one line puts the safe choice on top.
      const actions = safe.element().parentElement!;
      expect([...actions.children]).toEqual([safe.element(), confirm.element()]);
      expect(safe.element().classList.contains('cd-button--secondary')).toBe(true);
      expect(confirm.element().classList.contains('cd-button--primary')).toBe(true);
      const bounds = dialog.element().getBoundingClientRect();
      for (const button of [safe.element(), confirm.element()]) {
        const box = button.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(bounds.left);
        expect(box.right).toBeLessThanOrEqual(bounds.right);
      }
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(390);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      const before = changes();
      await userEvent.keyboard('{Escape}');
      await expect.element(control).toHaveFocus();
      expect(changes()).toEqual(before);
      await expect.element(control).toHaveAttribute('aria-checked', String(!next));
      if (source === 'sidebar') await expect.element(screen.getByRole('dialog', { name: 'Menu' })).toBeVisible();

      await control.click();
      await dialog.getByRole('button', { name: action, exact: true }).click();
      await expect.element(control).toHaveFocus();
      await expect.poll(changes).toEqual([...before, { on: next }]);
      await expect.poll(() => mockStore.world.desk(RIVERA.deskId)?.summary.answering).toBe(next);
      await expect.element(control).toHaveAccessibleDescription(next ? 'Within your rules' : 'Taking messages only');
    }
  });
});
