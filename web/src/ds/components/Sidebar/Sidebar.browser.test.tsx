/**
 * The "About this prototype" group sits above the Answering block without moving anything else:
 * the same sidebar with and without it keeps every other part where it was.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { NAV_LABELS, Sidebar, type SidebarHrefs, type SidebarProps } from './Sidebar.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const HREFS = Object.fromEntries(
  (['today', 'conversations', 'people', 'knowledge', 'rules', 'safety', 'profile', 'share', 'settings'] as const).map((key) => [key, `#${key}`]),
) as SidebarHrefs;

const PROPS: SidebarProps = {
  business: 'Turner Plumbing',
  onSwitchBusiness: () => {},
  desks: [{ id: 'desk-main', name: 'Main line' }],
  currentDeskId: 'desk-main',
  onSwitchDesk: () => {},
  current: 'today',
  hrefs: HREFS,
  peopleLabel: 'Customers',
  answering: true,
  onAnsweringChange: () => {},
  owner: { name: 'Mike Turner', status: 'Available for chats' },
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

it('connectors_row_only_with_its_href', () => {
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
    roots[1]?.render(<Sidebar {...PROPS} hrefs={{ ...HREFS, connectors: '#connectors' }} />);
  });

  const without = columns[0] as HTMLElement;
  const withConnectors = columns[1] as HTMLElement;
  const labels = (column: HTMLElement) => [...column.querySelectorAll('.cd-sidebar__nav .cd-sidebar__label')].map((label) => label.textContent);
  // Without its href there is no Connectors row, and no link without a destination.
  expect(labels(without)).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Safety', 'Profile', 'Share', 'Settings']);
  expect([...without.querySelectorAll('.cd-sidebar__nav > a')].every((link) => link.getAttribute('href'))).toBe(true);
  // With it, the tenth row, sixth.
  expect(labels(withConnectors)).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Connectors', 'Safety', 'Profile', 'Share', 'Settings']);
  // The labels the rows draw are the ones exported for pages to name themselves by; people's row is the consumer's.
  const { today, conversations, knowledge, rules, connectors, safety, profile, share, settings } = NAV_LABELS;
  expect(labels(withConnectors)).toEqual([today, conversations, 'Customers', knowledge, rules, connectors, safety, profile, share, settings]);

  // Nothing else moves: the top, the rows down to Rules and the pinned foot are where they were,
  // and the rows after Rules close up, one 38 px row apart as always, with no gap where it was.
  const boxes = (column: HTMLElement, selector: string) =>
    [...column.querySelectorAll<HTMLElement>(selector)].map((part) => {
      const box = part.getBoundingClientRect();
      const origin = column.getBoundingClientRect();
      return [box.left - origin.left, box.top - origin.top, box.width, box.height];
    });
  const fixed = '.cd-sidebar__brand, .cd-sidebar__business, .cd-sidebar__footer, .cd-sidebar__footer > *';
  expect(boxes(without, fixed)).toEqual(boxes(withConnectors, fixed));
  const rowsWithout = boxes(without, '.cd-sidebar__nav > a');
  const rowsWith = boxes(withConnectors, '.cd-sidebar__nav > a');
  expect(rowsWithout.slice(0, 5)).toEqual(rowsWith.slice(0, 5));
  expect(rowsWithout.slice(5)).toEqual(rowsWith.slice(5, 9));
  const tops = rowsWithout.map((box) => box[1] ?? 0);
  expect(tops.slice(1).map((top, index) => top - (tops[index] ?? 0))).toEqual([38, 38, 38, 38, 38, 38, 38, 38]);

  act(() => roots.forEach((root) => root.unmount()));
  columns.forEach((column) => column.remove());
});

it('only_connectors_may_be_left_out', () => {
  // Every other page's href is required. One missing anyway, past the types, still draws its row,
  // so a page never disappears from the nav by accident.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; width: 264px; height: 982px;';
  document.body.append(column);
  const root = createRoot(column);
  const { safety: _missing, ...withoutSafety } = HREFS;
  act(() => root.render(<Sidebar {...PROPS} hrefs={withoutSafety as SidebarHrefs} />));

  const labels = [...column.querySelectorAll('.cd-sidebar__nav .cd-sidebar__label')].map((label) => label.textContent);
  expect(labels).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Safety', 'Profile', 'Share', 'Settings']);

  act(() => root.unmount());
  column.remove();
});

it('long_business_name_carries_its_title', () => {
  // A name too long for the business row is cut with an ellipsis, and its title holds it in full,
  // so it can still be read; the row's name for screen readers stays the switcher's.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const name = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; width: 264px; height: 982px;';
  document.body.append(column);
  const root = createRoot(column);
  act(() => root.render(<Sidebar {...PROPS} business={name} />));

  const row = column.querySelector<HTMLElement>('.cd-sidebar__business');
  const shown = row?.querySelector<HTMLElement>('[data-copy="user"]');
  if (!row || !shown) throw new Error('the sidebar shows no business row');
  expect(row.getAttribute('aria-label')).toBe(`Switch business, current: ${name}`);
  expect(shown.textContent).toBe(name);
  expect(shown.scrollWidth).toBeGreaterThan(shown.clientWidth);
  expect(getComputedStyle(shown).textOverflow).toBe('ellipsis');
  expect(shown.title).toBe(name);

  act(() => root.unmount());
  column.remove();
});
