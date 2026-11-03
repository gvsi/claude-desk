import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { EV_ERROR_CODES, KERNEL_ERROR_CODES } from '../../../api/contracts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
import { UNREACHABLE_COPY } from './errorCopy.ts';
import { Notice } from './Notice.tsx';

const meta = {
  title: 'Status/Notice',
  component: Notice,
  args: { tone: 'info', children: null },
  render: (args) => (
    <div style={{ maxWidth: 640 }}>
      <Notice {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof Notice>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The notice's one dot: a status color, or hollow for info. */
async function dotOf(root: HTMLElement): Promise<Element> {
  // (No `new Error` in this file: the Error story's export shadows the global.)
  const dots = root.querySelectorAll('.cd-status-dot');
  await expect(dots).toHaveLength(1);
  return dots[0] as Element;
}

export const Info: Story = {
  args: {
    tone: 'info',
    children: 'Everything else overnight stayed inside your rules.',
    action: <TextLink href="#briefing">See the briefing</TextLink>,
  },
  parameters: { canvasNote: "The board's overnight line: a dot, one meta line and a link at the right." },
  play: async ({ canvas, canvasElement }) => {
    const notice = canvas.getByRole('status');
    await expect(notice).toHaveTextContent('Everything else overnight stayed inside your rules.');
    await expect(canvas.queryByRole('alert')).toBeNull();
    const link = canvas.getByRole('link', { name: 'See the briefing' });
    await expect(link).toBeVisible();
    // The link reads at the line's size, as on the board.
    expectComputed(link, { fontSize: '14px', lineHeight: '19px' });
    const dot = await dotOf(canvasElement);
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    await expect(dot).toHaveClass('cd-status-dot--info');
  },
};

export const Waiting: Story = {
  args: { tone: 'waiting', children: 'Reconnecting to the chat' },
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a reconnecting line; it takes the shape of N-Today-Run1's overnight line, with the held dot.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('Reconnecting to the chat');
    await expect(await dotOf(canvasElement)).toHaveClass('cd-status-dot--held');
  },
};

export const Error: Story = {
  args: { tone: 'error', children: "That didn't send. Your message is still here; try again." },
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a failed send; it takes the shape of N-Today-Run1's overnight line, with the refused dot.",
  },
  play: async ({ canvas, canvasElement }) => {
    // error_notice_is_an_alert
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent("That didn't send. Your message is still here; try again.");
    await expect(canvas.queryByRole('status')).toBeNull();
    await expect(await dotOf(canvasElement)).toHaveClass('cd-status-dot--refused');
  },
};

export const Unreachable: Story = {
  args: {
    tone: 'error',
    children: UNREACHABLE_COPY.en,
    action: (
      <Button variant="secondary" onClick={fn()}>
        Try again
      </Button>
    ),
  },
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows an outage; the static line from errorCopy.ts in the shape of N-Today-Run1's overnight line.",
  },
  play: async ({ canvas, canvasElement }) => {
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(UNREACHABLE_COPY.en);
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeEnabled();
    // The visitor reads what happened and what to do, never the code behind it.
    const text = canvasElement.textContent ?? '';
    for (const code of [...KERNEL_ERROR_CODES, ...EV_ERROR_CODES]) await expect(text).not.toContain(code);
  },
};
