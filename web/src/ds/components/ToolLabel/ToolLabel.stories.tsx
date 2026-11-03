import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { ToolLabel } from './ToolLabel.tsx';

const meta = {
  title: 'Conversation/ToolLabel',
  component: ToolLabel,
  args: { text: 'Searched your sample Claude memory' },
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote:
      "Setup's tool lines, between Claude's questions; no setup board is in the reference set, so it follows the meta lines in the Ask Claude panel on N-Conn-12-Chat.",
  },
} satisfies Meta<typeof ToolLabel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** tool_label_is_text: the label is its text and an icon hidden from screen readers, nothing to press. */
async function expectToolLabel(root: HTMLElement, text: string) {
  const label = root.querySelector('.cd-tool-label');
  if (!(label instanceof HTMLElement)) throw new Error('No tool label');
  await expect(label).toHaveTextContent(text);
  await expect(label.textContent).toBe(text);
  await expect(label.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
  const icon = label.querySelector('svg');
  await expect(icon).not.toBeNull();
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  expectComputed(label, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
}

export const Memory: Story = {
  play: async ({ args, canvasElement }) => {
    await expectToolLabel(canvasElement, args.text);
  },
};

export const Website: Story = {
  args: { text: 'Read turnerplumbing.example' },
  play: async ({ args, canvasElement }) => {
    await expectToolLabel(canvasElement, args.text);
  },
};

export const CouldNotRead: Story = {
  args: { text: "Couldn't read <your website>. I'll ask instead." },
  parameters: {
    canvasNote:
      "Setup's line when a website can't be read; its text comes from the API, so markup in it shows as text. Nearest board: N-Conn-12-Chat.",
  },
  play: async ({ args, canvasElement }) => {
    await expectToolLabel(canvasElement, args.text);
  },
};
