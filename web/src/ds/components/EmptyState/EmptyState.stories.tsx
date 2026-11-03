import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { EmptyState } from './EmptyState.tsx';

const meta = {
  title: 'Status/EmptyState',
  component: EmptyState,
  args: { title: 'No conversations yet', body: 'When someone writes to your Desk, it shows up here.' },
  render: (args) => (
    <div style={{ maxWidth: 360 }}>
      <EmptyState {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: 'No board shows an empty list; this is the conversation list of N-Conv-Run1 before anyone has written.',
  },
} satisfies Meta<typeof EmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NoConversations: Story = {
  play: async ({ canvas }) => {
    const title = canvas.getByText('No conversations yet');
    const body = canvas.getByText('When someone writes to your Desk, it shows up here.');
    await expect(title).toBeVisible();
    await expect(body).toBeVisible();
    // Says what will appear, quietly: the title in the interface's section style, the body secondary.
    expectComputed(title, { fontSize: '16px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(body, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No action was given, so there is no dead button.
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const WithoutTitle: Story = {
  args: { title: undefined, body: 'When a request is turned down or a reply is stopped, you’ll see here what was asked and why.' },
  parameters: { canvasNote: 'Safety on an empty week, where the headline above already says nothing was turned down.' },
  play: async ({ canvasElement, canvas }) => {
    // With the page's own line above saying it, the title is left out: no empty line holds its place.
    await expect(canvas.getByText(/you’ll see here what was asked and why/)).toBeVisible();
    await expect(canvasElement.querySelector('.cd-empty-state__title')).toBeNull();
    await expect(canvasElement.querySelector('.cd-empty-state')?.firstElementChild?.className).toContain('cd-empty-state__body');
  },
};
