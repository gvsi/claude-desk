import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import type { SessionMode } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { errorCopy } from '../Notice/errorCopy.ts';
import { TakeOverBar, type TakeOverBarProps } from './TakeOverBar.tsx';

const dana = rivera.conversations.danaLive;
const lucia = rivera.conversations.lucia;
const alex = rivera.conversations.alexAgent;
const ownerName = rivera.business.ownerName;

/** The bar's line that reads `text` in full, names included. */
function lineReading(root: HTMLElement, text: string): HTMLElement {
  const lines = [...root.querySelectorAll<HTMLElement>('p')].filter((line) => line.textContent === text);
  if (lines.length !== 1) throw new Error(`expected one line reading "${text}", found ${lines.length}`);
  return lines[0] as HTMLElement;
}

/**
 * The bar as the conversation screen holds it: each control reports to the story and the mode
 * follows it. With `failFirst`, the first take-over comes back with the screen's error line.
 */
function Screen({ failFirst = false, ...props }: TakeOverBarProps & { failFirst?: boolean }) {
  const [mode, setMode] = useState<SessionMode>(props.mode);
  const [error, setError] = useState(props.error);
  const [failed, setFailed] = useState(false);
  const change = (next: SessionMode, report: () => void) => () => {
    report();
    if (failFirst && !failed) {
      setFailed(true);
      setError(errorCopy('stale_generation'));
      return;
    }
    setError(undefined);
    setMode(next);
  };
  return (
    <TakeOverBar
      {...props}
      mode={mode}
      error={error}
      onTakeOver={change('owner', props.onTakeOver)}
      onHandBack={change('ai', props.onHandBack)}
      onResume={change('ai', props.onResume)}
    />
  );
}

const meta = {
  title: 'Owner decisions/TakeOverBar',
  component: TakeOverBar,
  args: {
    mode: 'ai',
    visitorName: dana.name,
    ownerName,
    onTakeOver: fn(),
    onHandBack: fn(),
    onResume: fn(),
  },
  // The conversation's content column, where the bar sits above the composer.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-content)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Conv-Live',
    canvasNote:
      'The board puts Take over beside the whisper composer with its lines beneath; the bar sits above the composer in the same reading and margin columns, and names are written in full, as the screen passes them.',
  },
} satisfies Meta<typeof TakeOverBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Answering: Story = {
  render: (args) => <Screen {...args} failFirst />,
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(lineReading(canvasElement, 'Whispers steer Claude. Dana Whitfield never sees them, and your rules still apply.')).toBeVisible();
    await expect(lineReading(canvasElement, 'Dana Whitfield sees “Maria Rivera joined the chat.”')).toBeVisible();
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    await expect(canvas.getAllByRole('button')).toEqual([takeOver]);
    expectComputed(takeOver, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });

    // take_over_by_keyboard: Tab reaches Take over, and Enter takes over, once.
    await userEvent.tab();
    await expect(takeOver).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onTakeOver).toHaveBeenCalledTimes(1);

    // The screen's error line shows, and Take over can be tried again.
    await expect(canvas.getByRole('alert')).toHaveTextContent(errorCopy('stale_generation'));
    await expect(takeOver).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect(args.onTakeOver).toHaveBeenCalledTimes(2);

    // In the chat now: the button it pressed is gone, so focus moves to the bar's first line.
    await expect(canvas.getByText("You're in this chat")).toHaveFocus();
    await expect(canvas.getByRole('button', { name: 'Hand back to Claude' })).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(args.onHandBack).not.toHaveBeenCalled();
  },
};

export const InChat: Story = {
  args: { mode: 'owner', visitorName: lucia.name },
  render: (args) => <Screen {...args} />,
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote:
      "The board puts Hand back to Claude beside the owner's composer with its lines beneath; the bar sits above the composer in the same columns. The translation line is static vision.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(canvas.getByText("You're in this chat")).toBeVisible();
    await expect(canvas.getByText("Claude won't send anything here until you hand it back.")).toBeVisible();
    await expect(lineReading(canvasElement, 'Lucía Herrera sees “Claude is helping again.”')).toBeVisible();
    const handBack = canvas.getByRole('button', { name: 'Hand back to Claude' });
    await expect(canvas.getAllByRole('button')).toEqual([handBack]);

    // hand_back_by_keyboard
    await userEvent.tab();
    await expect(handBack).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onHandBack).toHaveBeenCalledTimes(1);
    await expect(args.onTakeOver).not.toHaveBeenCalled();

    // Claude answers again, and focus moves to the bar's first line.
    await expect(lineReading(canvasElement, 'Whispers steer Claude. Lucía Herrera never sees them, and your rules still apply.')).toHaveFocus();
  },
};

export const Paused: Story = {
  args: { mode: 'paused', visitorName: 'Visitor' },
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote: "No board shows a paused chat; it takes the take-over footer's columns, with the held dot beside the line.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // paused_offers_resume_and_take_over: the held dot and the line, then Resume Claude first.
    const line = canvas.getByText('Claude paused this chat after repeated blocked attempts.');
    await expect(line).toBeVisible();
    const dots = canvasElement.querySelectorAll('.cd-status-dot');
    await expect(dots).toHaveLength(1);
    await expect(dots[0]).toHaveClass('cd-status-dot--held');
    const resume = canvas.getByRole('button', { name: 'Resume Claude' });
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    await expect(canvas.getAllByRole('button')).toEqual([resume, takeOver]);
    expectComputed(resume, { backgroundColor: 'rgb(239, 236, 228)' });
    expectComputed(takeOver, { backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    // Both fill the margin column, one above the other.
    await expect(resume.getBoundingClientRect().width).toBe(takeOver.getBoundingClientRect().width);
    await expect(takeOver.getBoundingClientRect().top).toBeGreaterThan(resume.getBoundingClientRect().bottom);
    await expect(canvasElement).not.toHaveTextContent('sees');

    await userEvent.click(resume);
    await expect(args.onResume).toHaveBeenCalledTimes(1);
    await userEvent.click(takeOver);
    await expect(args.onTakeOver).toHaveBeenCalledTimes(1);
    await expect(args.onHandBack).not.toHaveBeenCalled();
  },
};

export const Sending: Story = {
  args: { pending: true, error: errorCopy('stale_generation') },
  parameters: {
    canvasNote: 'No board shows a take-over being sent; the bar waits, and an earlier error line gives way to the new attempt.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const bar = canvasElement.querySelector('.cd-take-over');
    await expect(bar).toHaveAttribute('aria-busy', 'true');
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    await expect(takeOver).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.queryByRole('alert')).toBeNull();
    await userEvent.click(takeOver);
    await expect(args.onTakeOver).not.toHaveBeenCalled();
  },
};

export const Agent: Story = {
  args: { agent: true, visitorName: alex.name },
  render: (args) => <Screen {...args} />,
  parameters: {
    canvas: 'N-Conv-Agent',
    canvasNote:
      "The board shows a finished agent visit; while one is live the bar offers Take over, without the line about what the visitor sees, which agents never receive.",
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(lineReading(canvasElement, "Whispers steer Claude. Alex Kim's assistant never sees them, and your rules still apply.")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('sees “');

    // Taken over, the bar still says nothing about what the agent sees.
    await userEvent.click(canvas.getByRole('button', { name: 'Take over' }));
    await expect(canvas.getByText("You're in this chat")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('sees “');
  },
};
