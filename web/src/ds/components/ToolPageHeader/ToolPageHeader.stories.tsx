import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ToolPageHeader } from './ToolPageHeader.tsx';

const { refund, quote } = rivera.toolPages;

const meta = {
  title: 'Connectors/ToolPageHeader',
  component: ToolPageHeader,
  args: { ...refund, status: 'enabled' },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ToolPageHeader {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-05-Refund' },
} satisfies Meta<typeof ToolPageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The source line's status: its words and the tone of the dot beside them. */
async function expectStatus(root: HTMLElement, words: string, tone: 'handled' | 'info') {
  const status = root.querySelector('.cd-tool-page-header__status');
  if (!(status instanceof HTMLElement)) throw new Error('No status');
  await expect(status).toHaveTextContent(words);
  await expect(status.textContent).toBe(words);
  const dot = status.querySelector(`.cd-status-dot--${tone}`);
  await expect(dot).not.toBeNull();
  await expect(dot).toHaveAttribute('aria-hidden', 'true');
}

export const Refund: Story = {
  play: async ({ args, canvas, canvasElement }) => {
    // The tool's name is the page's serif h1, its description under it.
    const title = canvas.getByRole('heading', { level: 1, name: 'Refund' });
    expectComputed(title, { fontSize: '24px', fontFamily: '"Source Serif 4", Georgia, serif' });
    const description = canvas.getByText(args.description);
    expectComputed(description, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    // The source line: the 24 px tile, "From Stripe" with its Mock badge, and the status.
    const source = canvasElement.querySelector('.cd-tool-page-header__source');
    if (!(source instanceof HTMLElement)) throw new Error('No source line');
    await expect(source).toHaveTextContent('From Stripe Mock');
    expectComputed(source.querySelector('.cd-connector-icon') as Element, { width: '24px', height: '24px' });
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectStatus(canvasElement, 'On · Definition unchanged', 'handled');
    expectComputed(source, { fontSize: '13px' });
    await expect(source.getBoundingClientRect().top).toBeGreaterThanOrEqual(description.getBoundingClientRect().bottom);
  },
};

export const Quote: Story = {
  args: { ...quote, definitionNote: undefined, status: 'enabled' },
  parameters: {
    canvas: 'N-Conn-06-Quote',
    canvasNote: 'A built-in tool has no pinned definition, so it gets no definition note, where the board shows "Definition unchanged".',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Quote' })).toBeVisible();
    const source = canvasElement.querySelector('.cd-tool-page-header__source');
    if (!(source instanceof HTMLElement)) throw new Error('No source line');
    await expect(within(source).getByText('Built in')).toBeVisible();
    await expect(source).toHaveTextContent('From Quotes Built in');
    await expectStatus(canvasElement, 'On', 'handled');
  },
};

export const RefundNeedsReview: Story = {
  args: { ...refund, definitionNote: undefined, status: 'needs_review' },
  parameters: { canvas: 'N-Conn-14-Changed-Review' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'Off until you review a change', 'info');
  },
};

export const RefundReviewed: Story = {
  args: { ...refund, definitionNote: 'Definition reviewed today', status: 'enabled' },
  parameters: { canvas: 'N-Conn-15-Changed-After' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'On · Definition reviewed today', 'handled');
  },
};

export const Off: Story = {
  args: { ...refund, definitionNote: 'Definition unchanged', status: 'disabled' },
  parameters: { canvasNote: 'A tool the owner kept off; no board draws it. The definition note shows only while the tool is on.' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'Off', 'info');
  },
};
