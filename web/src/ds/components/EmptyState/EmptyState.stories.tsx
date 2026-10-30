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
    expectComputed(title, { fontSize: '15px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(body, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No action was given, so there is no dead button.
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};
