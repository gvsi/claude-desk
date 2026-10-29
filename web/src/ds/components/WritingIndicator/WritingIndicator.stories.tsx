import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { WritingIndicator } from './WritingIndicator.tsx';

const meta = {
  title: 'Conversation/WritingIndicator',
  component: WritingIndicator,
  args: { language: 'en' },
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: 'No board shows Claude writing; the indicator follows "Dana is typing" on N-Conv-Live, in the meta type the plan sets.',
  },
} satisfies Meta<typeof WritingIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * writing_state_shows_no_text: the indicator says who is writing and nothing more. No draft, no
 * partial reply: the canvas holds exactly the label.
 */
async function expectOnlyLabel(root: HTMLElement, status: HTMLElement, label: string) {
  await expect(status.textContent).toBe(label);
  await expect(root.textContent).toBe(label);
}

export const Claude: Story = {
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Claude is writing');
    expectComputed(status, { fontFamily: /Hanken Grotesk/, fontSize: '13px', lineHeight: '18px' });
    // writing_indicator_animates: it pulses, so the reduced-motion check has something to stop.
    expectComputed(status, { animationName: /^(?!none$).+/, animationDuration: '1.6s', animationIterationCount: 'infinite' });
  },
};

export const ClaudeEs: Story = {
  args: { language: 'es' },
  play: async ({ canvas }) => {
    const status = canvas.getByRole('status');
    await expect(status.textContent).toBe('Claude está escribiendo');
    await expect(status).toHaveAttribute('lang', 'es');
  },
};

export const VisitorTyping: Story = {
  args: { who: rivera.people.dana.name.split(' ')[0] },
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Dana is typing');
    // The name came from a person, so it is marked as their words; the rest is interface copy.
    await expect(canvas.getByText('Dana')).toHaveAttribute('data-copy', 'user');
  },
};
