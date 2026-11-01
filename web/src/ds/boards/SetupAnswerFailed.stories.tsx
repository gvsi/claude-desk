import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { proseBlock, rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { SetupFrame } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectFooterAtFoot, expectTabOrder, one } from './spec.ts';

/** Claude's third question, the owner's answer that couldn't be sent, and the screen's line, in the board's words. */
const QUESTION = 'Got it. Next: what’s the most a payment can be before I ask you? Deposits and payment links count.';
const ANSWER = '$500 is fine. Anything bigger, ask me.';
const FAILED_LINE = 'I couldn’t answer just now. Your answer is still here; try again.';

function SetupAnswerFailed() {
  return (
    <SetupFrame business={rivera.business.name}>
      <PageHeader title="Let's set up your Desk" subtitle="Question 3 of 7" />
      <div className="board-setup__stack">
        <Transcript label="Setup questions">
          <TranscriptRow>
            <ClaudeMessage blocks={[proseBlock(QUESTION)]} language="en" ownerName={rivera.business.ownerName} />
          </TranscriptRow>
        </Transcript>
        <Composer
          variant="owner"
          label="Answer in your own words"
          placeholder="Answer in your own words"
          maxLength={2000}
          onSend={fn()}
          failed={{ text: ANSWER, line: FAILED_LINE, onRetry: fn() }}
        />
      </div>
    </SetupFrame>
  );
}

const meta = {
  title: 'Boards/Setup, an answer failed',
  render: () => <SetupAnswerFailed />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Setup-04-Answer-Failed',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The setup interview’s questions when an answer couldn’t be sent: Claude’s question is a ClaudeMessage in the Transcript, and the line, the kept answer and “Try again” are the owner Composer’s failed state, the line in the screen’s words.',
      'The subtitle sits 4 px under the title, as PageHeader sets it on every page, where the board draws 6 px, so what follows sits 2 px higher.',
      'The step list in the bar (“Questions, Tools, Rules, Safety check, Live”) is left out of the setup frame, as on the other setup board stories; the bar, the column and its 20 px gaps are page layout the web app (plan 04) owns.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    // The bar's lockup as the setup boards draw it: the 20 px bell, then the wordmark 10 px on.
    const brand = one(canvasElement, '.board-setup__brand');
    const bell = one(brand, '.cd-mark').getBoundingClientRect();
    await expect([Math.round(bell.width), Math.round(bell.height)]).toEqual([20, 20]);
    await expect(Math.round(one(brand, '.cd-wordmark').getBoundingClientRect().left - bell.right)).toBe(10);
    expectComputed(canvas.getByRole('heading', { level: 1, name: "Let's set up your Desk" }), SPEC.pageTitle);
    await expect(canvas.getByText('Question 3 of 7')).toBeVisible();
    expectConversationType(canvasElement);
    await expect(canvas.getByRole('log', { name: 'Setup questions' })).toHaveTextContent(QUESTION);

    // The question 20 px under the header, the line 20 px under it, then 20 px under that the
    // composer's box, 720 px wide in the column and 56 px high, as the board draws them. (The
    // header's subtitle sits 4 px under its title, PageHeader's gap, where the board draws 6 px, so
    // all of this sits 2 px higher than the render: the box at 285 px, not 287.)
    const log = canvas.getByRole('log', { name: 'Setup questions' });
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(FAILED_LINE);
    await expect(Math.round(alert.getBoundingClientRect().top - log.getBoundingClientRect().bottom)).toBe(20);
    const kept = canvas.getByText(ANSWER);
    const box = one(canvasElement, '.cd-composer__box');
    expectComputed(box, SPEC.composer);
    const rect = box.getBoundingClientRect();
    const header = canvas.getByRole('heading', { level: 1 }).closest('header')!;
    await expect(Math.round(log.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBe(20);
    await expect([Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]).toEqual([396, 285, 720, 56]);
    await expect(Math.round(rect.top - alert.getBoundingClientRect().bottom)).toBe(20);
    await expect(box.contains(kept)).toBe(true);

    // "Try again", the one primary, inside the box at its right; nothing to type into.
    const tryAgain = canvas.getByRole('button', { name: 'Try again' });
    expectComputed(tryAgain, SPEC.primary);
    await expect(Math.round(rect.right - tryAgain.getBoundingClientRect().right)).toBe(14);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: Save and exit, then Try again.
    await expectTabOrder(userEvent, [canvas.getByRole('button', { name: 'Save and exit' }), tryAgain]);
  },
};
