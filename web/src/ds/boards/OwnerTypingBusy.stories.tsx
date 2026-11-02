import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../api/contracts.ts';
import { Button } from '../components/Button/Button.tsx';
import { PersonMessage } from '../components/PersonMessage/PersonMessage.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { WritingIndicator } from '../components/WritingIndicator/WritingIndicator.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { Panel, Sheet } from './parts.tsx';
import { one } from './spec.ts';

const OWNER = rivera.business.ownerName;
const said = rivera.events.takeOver.find((event: SseEvent): event is EvMessage => event.type === 'message');
if (!said) throw new Error('the Turner fixture has no owner message in its take-over');

/** Dana's chat on the public page after she asked for Mike: Mike joined, then types or has sent. */
function DanaSeesMaria({ landed }: { landed: boolean }) {
  return (
    <Transcript label="Conversation with Turner Plumbing">
      <TranscriptRow>
        <VisitorMessage text={`I'd like to talk to ${OWNER}.`} />
      </TranscriptRow>
      <SystemLine text={`${OWNER} joined the chat`} initials="MT" />
      <TranscriptRow>
        {landed ? <PersonMessage name={OWNER} blocks={said!.blocks} language={said!.language} /> : <WritingIndicator variant="person" who={OWNER} language="en" />}
      </TranscriptRow>
    </Transcript>
  );
}

/** Each button weight at rest and busy, side by side, the same label. */
const BUSY_ROWS = [
  { variant: 'primary', label: 'Start the demo' },
  { variant: 'secondary', label: 'Allow this time' },
  { variant: 'ghost', label: 'Reset demo' },
] as const;

function OwnerTypingBusy() {
  return (
    <Sheet title="Owner typing and busy buttons" gap={32}>
      <Panel label="Dana’s view on the public page, while Mike types" width={380} compact>
        <DanaSeesMaria landed={false} />
      </Panel>
      <Panel label="Mike’s message lands: same left edge, nothing jumps" width={380} compact>
        <DanaSeesMaria landed />
      </Panel>
      <Panel label="Mike’s own screen, Dana typing: the signed bubble, for contrast" width={376} compact>
        <Transcript label={`Conversation with ${rivera.people.dana.name}`}>
          <TranscriptRow>
            <VisitorMessage text="Yes please. Anything sooner though?" />
          </TranscriptRow>
          <TranscriptRow>
            <WritingIndicator variant="bubble" who="Dana" language="en" />
          </TranscriptRow>
        </Transcript>
      </Panel>
      <Panel label="Dana’s view on a phone, 390" width={390} phone>
        <DanaSeesMaria landed={false} />
      </Panel>
      <Panel label="Busy buttons: a spinner in place of the label, at the same width">
        <table className="board-busy">
          <thead>
            <tr>
              <th scope="col" className="cd-type-caption">
                Weight
              </th>
              <th scope="col" className="cd-type-caption">
                At rest
              </th>
              <th scope="col" className="cd-type-caption">
                Busy, same width
              </th>
            </tr>
          </thead>
          <tbody>
            {BUSY_ROWS.map((row) => (
              <tr key={row.variant}>
                <th scope="row" className="cd-type-meta">
                  {row.variant === 'primary' ? 'Primary' : row.variant === 'secondary' ? 'Secondary' : 'Ghost'}
                </th>
                <td data-weight={row.variant} data-state="rest">
                  <Button variant={row.variant} size={row.variant === 'ghost' ? 'inline' : 'main'} onClick={fn()}>
                    {row.label}
                  </Button>
                </td>
                <td data-weight={row.variant} data-state="busy">
                  <Button variant={row.variant} size={row.variant === 'ghost' ? 'inline' : 'main'} busy onClick={fn()}>
                    {row.label}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Sheet>
  );
}

const meta = {
  title: 'Boards/Owner typing and busy',
  render: () => <OwnerTypingBusy />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Typing-Owner-Busy',
    canvasNote: [
      'The board’s panels from WritingIndicator, PersonMessage, SystemLine and Button. Mike’s message is the Turner fixture’s, where the board writes that he is looking at the photos.',
      'Busy buttons show the spinner signed later the same day in place of the board’s three dots, at the same width and only on the pressed button; the busy row leaves out red buttons, reserved for refusals and deletes that cannot be undone (owner decision, 2026-11-02).',
      'The board’s title, explanations and “How it behaves” list are sign-off notes and stay in the canvas; its dashed outlines marked parts before they were built.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas }) => {
    // Owner typing: his initials and name as on his messages, three dots where his words start,
    // no fill and no bubble; screen readers hear "Mike Turner is typing".
    const typing = canvas.getByRole('region', { name: 'Dana’s view on the public page, while Mike types' });
    // The joined line is a status too; the typing line is the one that says so.
    const status = within(typing)
      .getAllByRole('status')
      .find((line) => line.textContent === `${OWNER} is typing`) as HTMLElement;
    await expect(status).toBeDefined();
    const frame = status.closest<HTMLElement>('.cd-writing-indicator') as HTMLElement;
    expectComputed(frame, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    await expect(frame.querySelector('.cd-writing-indicator__bubble')).toBeNull();
    const avatar = one(frame, '.cd-person-message__avatar');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');

    // His message lands from the same left edge.
    const landed = canvas.getByRole('region', { name: 'Mike’s message lands: same left edge, nothing jumps' });
    const landedAvatar = one(landed, '.cd-person-message__avatar');
    const rowLeft = (el: HTMLElement) => (el.closest('.cd-transcript-row') as HTMLElement).getBoundingClientRect().left;
    await expect(avatar.getBoundingClientRect().left - rowLeft(avatar)).toBe(landedAvatar.getBoundingClientRect().left - rowLeft(landedAvatar));

    // Mike's own screen keeps the visitor's bubble.
    const own = canvas.getByRole('region', { name: 'Mike’s own screen, Dana typing: the signed bubble, for contrast' });
    await expect(within(own).getByRole('status')).toHaveTextContent('Dana is typing');
    await expect(own.querySelector('.cd-writing-indicator__bubble')).not.toBeNull();

    // Busy: a spinner in place of the label, the same width as at rest, the label still its name.
    const busyPanel = canvas.getByRole('region', { name: 'Busy buttons: a spinner in place of the label, at the same width' });
    for (const row of BUSY_ROWS) {
      const rest = one(busyPanel, `[data-weight="${row.variant}"][data-state="rest"] button`);
      const busy = one(busyPanel, `[data-weight="${row.variant}"][data-state="busy"] button`);
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await expect(busy).toHaveAccessibleName(row.label);
      await expect(busy.querySelector('.cd-button__spinner')).not.toBeNull();
      await expect(rest.getBoundingClientRect().width).toBe(busy.getBoundingClientRect().width);
    }
  },
};
