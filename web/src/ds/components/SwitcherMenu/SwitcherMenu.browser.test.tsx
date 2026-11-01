/**
 * A business name too long for the switcher's row is cut with an ellipsis and carries its whole self
 * as its title, as the sidebar's business row does, so it can still be read; the row's name for
 * screen readers stays its name and Desk count.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

import { SwitcherMenu, type SwitcherBusiness } from './SwitcherMenu.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const LONG_NAME = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';

const BUSINESSES: SwitcherBusiness[] = [
  { id: 'biz-bayview', name: LONG_NAME, desks: [{ id: 'desk-bayview-main', name: 'Main line' }] },
  {
    id: 'biz-rivera',
    name: 'Turner Plumbing',
    desks: [
      { id: 'desk-rivera-main', name: 'Main line' },
      { id: 'desk-rivera-emergencies', name: 'Emergencies' },
    ],
  },
];

it('long_business_name_carries_its_title', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  act(() => root.render(<SwitcherMenu businesses={BUSINESSES} currentBusinessId="biz-bayview" onPick={noop} onNewBusiness={noop} onClose={noop} />));

  try {
    const menu = page.getByRole('menu', { name: 'Switch business' });
    // Each row keeps its name and Desk count as its name for screen readers, the title adding nothing to it.
    const bayview = menu.getByRole('menuitemradio', { name: `${LONG_NAME} 1 Desk`, exact: true });
    const rivera = menu.getByRole('menuitemradio', { name: 'Turner Plumbing 2 Desks', exact: true });
    await expect.element(bayview).toBeVisible();
    await expect.element(rivera).toBeVisible();

    const nameOf = (row: HTMLElement) => {
      const name = row.querySelector<HTMLElement>('.cd-switcher-menu__name');
      if (!name) throw new Error('a business row shows no name');
      return name;
    };
    // The long name is cut with an ellipsis, and its title holds it in full.
    const long = nameOf(bayview.element() as HTMLElement);
    expect(long.textContent).toBe(LONG_NAME);
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(getComputedStyle(long).textOverflow).toBe('ellipsis');
    expect(long.title).toBe(LONG_NAME);
    // A name that fits carries its title too, as every business name the owner app cuts does.
    const short = nameOf(rivera.element() as HTMLElement);
    expect(short.scrollWidth).toBeLessThanOrEqual(short.clientWidth);
    expect(short.title).toBe('Turner Plumbing');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
