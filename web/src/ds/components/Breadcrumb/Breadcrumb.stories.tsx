import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { Breadcrumb } from './Breadcrumb.tsx';

const meta = {
  title: 'Navigation/Breadcrumb',
  component: Breadcrumb,
  args: {
    items: [
      { label: 'Connectors', href: '/connectors' },
      { label: 'Stripe', href: '/connectors/stripe' },
      { label: 'Refund' },
    ],
  },
  parameters: { layout: 'padded', canvas: 'N-Conn-05-Refund' },
} satisfies Meta<typeof Breadcrumb>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ToolPage: Story = {
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // breadcrumb_marks_the_page: a nav named "Breadcrumb" holding an ordered list.
    const nav = canvas.getByRole('navigation', { name: 'Breadcrumb' });
    const list = within(nav).getByRole('list');
    await expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    await expect(items).toHaveLength(3);
    // Two links, then "Refund" as plain text, marked as the page.
    const links = within(nav).getAllByRole('link');
    // The trail starts at Connectors, where a connector's and a tool's pages live.
    await expect(links.map((link) => link.textContent)).toEqual(['Connectors', 'Stripe']);
    await expect(links.map((link) => link.getAttribute('href'))).toEqual(['/connectors', '/connectors/stripe']);
    const current = within(nav).getByText('Refund');
    await expect(current.closest('a')).toBeNull();
    await expect(current).toHaveAttribute('aria-current', 'page');
    // The separators are the boards' "/", hidden from screen readers.
    const separators = nav.querySelectorAll('[aria-hidden="true"]');
    await expect(separators).toHaveLength(2);
    for (const separator of separators) await expect(separator).toHaveTextContent('/');
    await expect(nav).toHaveTextContent('Connectors/Stripe/Refund');
    // As the board draws it: meta type, the links in accent blue and underlined, the page in primary text.
    expectComputed(links[0] as Element, { fontSize: '14px', color: 'rgb(126, 174, 218)', textDecorationLine: 'underline' });
    expectComputed(current, { color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(separators[0] as Element, { color: 'rgba(250, 249, 245, 0.6)' });
  },
};

/** A name the voice rules would flag if it were the trail's own words: its initials are in capitals. */
const MARKED_NAME = 'JJ Okafor';

export const MarkedName: Story = {
  name: 'A name marked as theirs',
  args: {
    items: [{ label: 'Customers', href: '/people' }, { label: <bdi data-copy="user">{MARKED_NAME}</bdi> }],
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws a trail with a name someone chose in it. A label can be a node, so a screen marks a customer’s or a business’s name as user text; the nearest board is N-Conn-05-Refund.',
  },
  play: async ({ canvas }) => {
    // breadcrumb_name_is_user_text: the page's label holds the name, marked as theirs.
    const nav = canvas.getByRole('navigation', { name: 'Breadcrumb' });
    const current = nav.querySelector('[aria-current="page"]');
    await expect(current).toHaveTextContent(new RegExp(`^${MARKED_NAME}$`));
    const marked = current?.querySelector('[data-copy="user"]');
    await expect(marked).toHaveTextContent(new RegExp(`^${MARKED_NAME}$`));
    await expect(within(nav).getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/people');
    await expect(nav).toHaveTextContent(`Customers/${MARKED_NAME}`);
  },
};
