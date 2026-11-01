import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import type { SessionMode } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
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

/** The whisper line while Claude answers: the visitor's name set off at its start. */
async function expectWhisperLine(root: HTMLElement, visitor: string): Promise<HTMLElement> {
  const line = lineReading(root, `${visitor} never sees whispers. Whispers steer Claude, and your rules still apply.`);
  await expectSetOffName(line, visitor);
  return line;
}

/** The line saying what the visitor sees, the visitor's name set off at its start. */
async function expectSeesLine(root: HTMLElement, visitor: string, sees: string): Promise<void> {
  await expectSetOffName(lineReading(root, `${visitor} sees “${sees}”`), visitor);
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

/**
 * The bar as the conversation screen holds it while a change is sent: a press reports to the story
 * and the change stays pending, so the bar keeps waiting.
 */
function SendingScreen(props: TakeOverBarProps) {
  const [pending, setPending] = useState(false);
  const send = (report: () => void) => () => {
    report();
    setPending(true);
  };
  return (
    <TakeOverBar
      {...props}
      pending={pending}
      onTakeOver={send(props.onTakeOver)}
      onHandBack={send(props.onHandBack)}
      onResume={send(props.onResume)}
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
    canvas: 'N-Conv-Run1',
    canvasNote:
      'The board puts Take over beside the whisper composer with its lines beneath; the bar sits above the composer with its lines in the reading column and its controls beside them, and names are written in full, as the screen passes them.',
  },
} satisfies Meta<typeof TakeOverBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Answering: Story = {
  render: (args) => <Screen {...args} failFirst />,
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(await expectWhisperLine(canvasElement, 'Dana Whitfield')).toBeVisible();
    await expectSeesLine(canvasElement, 'Dana Whitfield', 'Mike Turner joined the chat.');
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

export const AvailableWidth: Story = {
  args: { visitorName: 'Visitor' },
  decorators: [(Story) => <div style={{ width: 'var(--size-reading)', maxWidth: '100%' }}><Story /></div>],
  parameters: {
    canvasNote: 'The bar at the composer width: the controls wrap below the lead and the hint uses the whole row, wrapping only when its words no longer fit.',
  },
  play: async ({ canvasElement }) => {
    const line = lineReading(canvasElement, 'Visitor sees “Mike Turner joined the chat.”');
    const action = line.parentElement as HTMLElement;
    const bar = action.parentElement as HTMLElement;
    await expect(action.getBoundingClientRect().width).toBe(bar.getBoundingClientRect().width);
    const range = document.createRange();
    range.selectNodeContents(line);
    await expect(new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size).toBe(1);
    expectComputed(line, { whiteSpace: 'normal' });
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
    await expectSeesLine(canvasElement, 'Lucía Herrera', 'Claude is helping again.');
    const handBack = canvas.getByRole('button', { name: 'Hand back to Claude' });
    await expect(canvas.getAllByRole('button')).toEqual([handBack]);

    // hand_back_by_keyboard
    await userEvent.tab();
    await expect(handBack).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onHandBack).toHaveBeenCalledTimes(1);
    await expect(args.onTakeOver).not.toHaveBeenCalled();

    // Claude answers again, and focus moves to the bar's first line.
    await expect(await expectWhisperLine(canvasElement, 'Lucía Herrera')).toHaveFocus();
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
    // Both fill the controls column, one above the other.
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
    // Sent from elsewhere, not pressed here: it waits in its busy colors with no spinner.
    await expect(takeOver).not.toHaveAttribute('aria-busy');
    await expect(takeOver.querySelector('.cd-button__spinner')).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await userEvent.click(takeOver);
    await expect(args.onTakeOver).not.toHaveBeenCalled();
  },
};

export const ResumeSending: Story = {
  args: { mode: 'paused', visitorName: 'Visitor' },
  render: (args) => <SendingScreen {...args} />,
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote:
      'No board shows a paused chat resuming; only the pressed button spins, as on a held request, and the other waits in its busy colors.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const resume = canvas.getByRole('button', { name: 'Resume Claude' });
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    await userEvent.click(resume);
    await expect(args.onResume).toHaveBeenCalledTimes(1);
    await expect(canvasElement.querySelector('.cd-take-over')).toHaveAttribute('aria-busy', 'true');
    for (const button of [resume, takeOver]) await expect(button).toHaveAttribute('aria-disabled', 'true');
    // spinner_on_the_pressed_button: Resume Claude spins and keeps focus; Take over can't be pressed,
    // in its busy colors with no spinner.
    await expect(resume).toHaveAttribute('aria-busy', 'true');
    await expect(resume.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    await expect(resume).toHaveFocus();
    await expect(takeOver).not.toHaveAttribute('aria-busy');
    await expect(takeOver.querySelector('.cd-button__spinner')).toBeNull();
    await waitFor(() => expectComputed(takeOver, { color: 'rgba(250, 249, 245, 0.64)', backgroundColor: 'rgba(250, 249, 245, 0.1)', opacity: '1' }));
    await userEvent.click(takeOver);
    await userEvent.click(resume);
    await expect(args.onTakeOver).not.toHaveBeenCalled();
    await expect(args.onResume).toHaveBeenCalledTimes(1);
  },
};

export const Agent: Story = {
  args: { agent: true, visitorName: alex.name },
  render: (args) => <Screen {...args} />,
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote:
      "The board shows a finished agent visit; while one is live the bar offers Take over, without the line about what the visitor sees, which agents never receive.",
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(await expectWhisperLine(canvasElement, "Alex Kim's assistant")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('sees “');

    // Taken over, the bar still says nothing about what the agent sees.
    await userEvent.click(canvas.getByRole('button', { name: 'Take over' }));
    await expect(canvas.getByText("You're in this chat")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('sees “');
  },
};
