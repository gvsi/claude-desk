import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Breadcrumb } from './Breadcrumb.tsx';

const meta = {
  title: 'Navigation/Breadcrumb',
  component: Breadcrumb,
  args: {
    items: [
      { label: 'Rules', href: '/rules' },
      { label: 'Stripe', href: '/rules/stripe' },
      { label: 'Refund' },
    ],
  },
  parameters: { layout: 'padded', canvas: 'N-Conn-05-Refund' },
} satisfies Meta<typeof Breadcrumb>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ToolPage: Story = {
  play: async ({ canvas }) => {
    // breadcrumb_marks_the_page: a nav named "Breadcrumb" holding an ordered list.
    const nav = canvas.getByRole('navigation', { name: 'Breadcrumb' });
    const list = within(nav).getByRole('list');
    await expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    await expect(items).toHaveLength(3);
    // Two links, then "Refund" as plain text, marked as the page.
    const links = within(nav).getAllByRole('link');
    await expect(links.map((link) => link.textContent)).toEqual(['Rules', 'Stripe']);
    await expect(links.map((link) => link.getAttribute('href'))).toEqual(['/rules', '/rules/stripe']);
    const current = within(nav).getByText('Refund');
    await expect(current.closest('a')).toBeNull();
    await expect(current).toHaveAttribute('aria-current', 'page');
    // The separators are the boards' "/", hidden from screen readers.
    const separators = nav.querySelectorAll('[aria-hidden="true"]');
    await expect(separators).toHaveLength(2);
    for (const separator of separators) await expect(separator).toHaveTextContent('/');
    await expect(nav).toHaveTextContent('Rules/Stripe/Refund');
    // As the board draws it: meta type, the links in accent blue and underlined, the page in primary text.
    expectComputed(links[0] as Element, { fontSize: '13px', color: 'rgb(126, 174, 218)', textDecorationLine: 'underline' });
    expectComputed(current, { color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(separators[0] as Element, { color: 'rgba(250, 249, 245, 0.6)' });
  },
};
