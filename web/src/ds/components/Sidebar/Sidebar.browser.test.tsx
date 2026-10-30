/**
 * The "About this prototype" group sits above the Answering block without moving anything else:
 * the same sidebar with and without it keeps every other part where it was.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { Sidebar, type NavKey, type SidebarProps } from './Sidebar.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const HREFS = Object.fromEntries(
  (['today', 'conversations', 'people', 'rules', 'safety', 'share', 'settings'] as const).map((key) => [key, `#${key}`]),
) as Record<NavKey, string>;

const PROPS: SidebarProps = {
  business: 'Rivera Plumbing',
  onSwitchBusiness: () => {},
  desks: [{ id: 'desk-main', name: 'Main line' }],
  currentDeskId: 'desk-main',
  onSwitchDesk: () => {},
  current: 'today',
  hrefs: HREFS,
  peopleLabel: 'Customers',
  answering: true,
  onAnsweringChange: () => {},
  owner: { name: 'Maria Rivera', status: 'Available for chats' },
};

const ABOUT: NonNullable<SidebarProps['about']> = {
  title: 'About this prototype',
  links: [
    { id: 'proposal', label: 'Product proposal', href: '#docs/product-proposal' },
    { id: 'prediction', label: 'Capability prediction', href: '#docs/capability-prediction' },
  ],
};

/** Where each part of a rendered sidebar sits, relative to its column. */
function layoutOf(column: HTMLElement): Record<string, [number, number, number, number]> {
  const origin = column.getBoundingClientRect();
  const parts = [
    ...column.querySelectorAll<HTMLElement>(
      '.cd-sidebar__brand, .cd-sidebar__business, .cd-sidebar__nav, .cd-sidebar__nav > a, .cd-sidebar__footer, .cd-sidebar__footer > *',
    ),
  ];
  return Object.fromEntries(
    parts.map((part, index) => {
      const box = part.getBoundingClientRect();
      return [`${index} ${part.className}`, [box.left - origin.left, box.top - origin.top, box.width, box.height]];
    }),
  );
}

it('about_group_moves_nothing_else', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const columns = [false, true].map(() => {
    const column = document.createElement('div');
    column.style.cssText = 'display: flex; width: 264px; height: 982px;';
    document.body.append(column);
    return column;
  });
  const roots = columns.map((column) => createRoot(column));
  act(() => {
    roots[0]?.render(<Sidebar {...PROPS} />);
    roots[1]?.render(<Sidebar {...PROPS} about={ABOUT} />);
  });

  const without = columns[0] as HTMLElement;
  const withAbout = columns[1] as HTMLElement;
  // The group is there in one and not the other, between the nav and the foot.
  expect(without.querySelector('.cd-sidebar__about')).toBeNull();
  const group = withAbout.querySelector<HTMLElement>('.cd-sidebar__about');
  expect(group).not.toBeNull();
  expect(group?.getBoundingClientRect().top).toBeGreaterThan(withAbout.querySelector<HTMLElement>('.cd-sidebar__nav')?.getBoundingClientRect().bottom ?? Infinity);
  // Everything else is where it was, the foot still at the column's foot.
  expect(layoutOf(withAbout)).toEqual(layoutOf(without));

  act(() => roots.forEach((root) => root.unmount()));
  columns.forEach((column) => column.remove());
});
