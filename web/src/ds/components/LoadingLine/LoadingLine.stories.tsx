import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { LoadingLine } from './LoadingLine.tsx';

const meta = {
  title: 'Status/LoadingLine',
  component: LoadingLine,
  args: { children: 'Loading your customers' },
  render: (args) => (
    <div style={{ maxWidth: 760 }}>
      <LoadingLine {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-People-Loading' },
} satisfies Meta<typeof LoadingLine>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: { canvasNote: 'The line under the Customers header while the list loads: the spinner, then the words.' },
  play: async ({ canvas, canvasElement }) => {
    // loading_line_says_what_is_loading: a status that names what is on its way, in meta type.
    const line = canvas.getByRole('status');
    await expect(line).toHaveTextContent(/^Loading your customers$/);
    expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });

    // The busy button's spinner, hidden from screen readers, 10 px before the words and centered on them.
    const spinner = canvasElement.querySelector('svg');
    await expect(spinner).not.toBeNull();
    await expect(spinner).toHaveAttribute('aria-hidden', 'true');
    const box = spinner!.getBoundingClientRect();
    await expect([box.width, box.height]).toEqual([16, 16]);
    const words = canvas.getByText('Loading your customers');
    const text = words.getBoundingClientRect();
    await expect(Math.round(text.left - box.right)).toBe(10);
    await expect(Math.round(box.top + box.height / 2)).toBe(Math.round(text.top + text.height / 2));
    // It turns once every motion-spin, at an even speed.
    expectComputed(spinner!, { animationDuration: '0.8s', animationTimingFunction: 'linear', animationIterationCount: 'infinite' });
  },
};

export const Spanish: Story = {
  args: { children: 'Cargando tus clientes' },
  render: (args) => (
    <div lang="es" style={{ maxWidth: 760 }}>
      <LoadingLine {...args} />
    </div>
  ),
  parameters: { canvas: 'none', canvasNote: 'N-Run2-People-Loading in Spanish: the screen passes the words in the reader’s language.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(/^Cargando tus clientes$/);
  },
};
