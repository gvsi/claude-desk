import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { ConceptFooter } from './ConceptFooter.tsx';

const meta = {
  title: 'Layout/ConceptFooter',
  component: ConceptFooter,
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
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
  },
};

export const PoweredBy: Story = {
  args: { poweredBy: true },
  parameters: {
    canvas: 'N-Public-Rivera',
    canvasNote: 'The board draws a 14 px mark; here it is the smallest mark size, 16 px.',
  },
  play: async ({ canvas, canvasElement }) => {
    // The concept line stays exact; "Powered by" sits beside it, never inside it.
    await expect(canvasElement.querySelector('[data-ds="concept-footer"]')).toHaveTextContent(new RegExp(`^${CONCEPT}$`));
    await expect(canvas.getByText(/Powered by/)).toHaveTextContent(/^Powered by Claude Desk$/);
    await expect(canvasElement.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  },
};
