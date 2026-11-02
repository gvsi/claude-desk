import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { ConceptFooter } from './ConceptFooter.tsx';

const meta = {
  title: 'Layout/ConceptFooter',
  component: ConceptFooter,
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof ConceptFooter>;

export default meta;

type Story = StoryObj<typeof meta>;

const CONCEPT = 'Concept prototype by Giovanni Alcantara, not an Anthropic product';

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const footer = canvasElement.querySelector('[data-ds="concept-footer"]');
    await expect(footer).toHaveTextContent(new RegExp(`^${CONCEPT}$`));
    await expect(footer).toHaveClass('cd-type-caption');
    await expect(canvas.queryByText(/Powered by/)).toBeNull();
    // footer_name_links_to_the_authors_profile: only the name is a link, opening LinkedIn in a new tab.
    const name = canvas.getByRole('link', { name: 'Giovanni Alcantara' });
    await expect(name).toHaveAttribute('href', 'https://www.linkedin.com/in/giovannialcantara/');
    await expect(name).toHaveAttribute('target', '_blank');
    await expect(name).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(name).toHaveClass('cd-text-link');
    await expect(footer?.querySelectorAll('a')).toHaveLength(1);
  },
};

export const Skeleton: Story = {
  args: { skeleton: true },
  play: async ({ canvas, canvasElement }) => {
    // footer_name_in_a_skeleton_is_no_link: the same words and the link's colour, with nothing to focus.
    const footer = canvasElement.querySelector('[data-ds="concept-footer"]');
    await expect(footer).toHaveTextContent(new RegExp(`^${CONCEPT}$`));
    await expect(canvas.queryByRole('link')).toBeNull();
    const name = canvas.getByText('Giovanni Alcantara');
    await expect(name).toHaveClass('cd-text-link');
    await expect(name.tabIndex).toBe(-1);
  },
};

export const PoweredBy: Story = {
  args: { poweredBy: true },
  parameters: {
    canvas: 'N-Public-Rivera-Run1',
    canvasNote:
      'The board draws a 14 px mark on its tile; here it is the smallest mark size, 16 px, with no tile in its light ink (N-Explore-Mark-Decided, signed 2026-10-30).',
  },
  play: async ({ canvas, canvasElement }) => {
    // The concept line stays exact; "Powered by" sits beside it, never inside it.
    await expect(canvasElement.querySelector('[data-ds="concept-footer"]')).toHaveTextContent(new RegExp(`^${CONCEPT}$`));
    await expect(canvas.getByText(/Powered by/)).toHaveTextContent(/^Powered by Claude Desk$/);
    const mark = canvasElement.querySelector('svg.cd-mark') as SVGSVGElement;
    await expect(mark).toHaveAttribute('aria-hidden', 'true');
    // powered_by_mark_has_no_tile: the 16 px bell with no tile, in its light ink on the dark page.
    await expect(mark.getAttribute('width')).toBe('16');
    await expect(mark.querySelector('rect')).toBeNull();
    expectComputed(mark.querySelector(':scope > g > g:last-child') as Element, { fill: 'rgb(250, 249, 245)' });
  },
};
