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
if (!said) throw new Error('the Rivera fixture has no owner message in its take-over');

/** Dana's chat on the public page after she asked for Maria: Maria joined, then types or has sent. */
function DanaSeesMaria({ landed }: { landed: boolean }) {
  return (
    <Transcript label="Conversation with Rivera Plumbing">
      <TranscriptRow>
        <VisitorMessage text={`I'd like to talk to ${OWNER}.`} />
      </TranscriptRow>
      <SystemLine text={`${OWNER} joined the chat`} initials="MR" />
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
  { variant: 'ghost', label: 'Start over' },
] as const;

function OwnerTypingBusy() {
  return (
    <Sheet title="Owner typing and busy buttons">
      <Panel label="Dana’s view on the public page, while Maria types">
        <DanaSeesMaria landed={false} />
      </Panel>
      <Panel label="Maria’s message lands: same left edge, nothing jumps">
        <DanaSeesMaria landed />
      </Panel>
      <Panel label="Maria’s own screen, Dana typing: the signed bubble, for contrast">
        <Transcript label={`Conversation with ${rivera.people.dana.name}`}>
          <TranscriptRow>
            <VisitorMessage text="Yes please. Anything sooner though?" />
          </TranscriptRow>
          <TranscriptRow>
            <WritingIndicator variant="bubble" who="Dana" language="en" />
          </TranscriptRow>
        </Transcript>
      </Panel>
      <Panel label="Dana’s view on a phone, 390" phone>
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
      'The board’s panels from WritingIndicator, PersonMessage, SystemLine and Button. Maria’s message is the Rivera fixture’s, where the board writes that she is looking at the photos.',
      'Busy buttons show the spinner signed later the same day in place of the board’s three dots, at the same width and only on the pressed button; the busy row leaves out the red refusals, which only an approval card’s Deny shows.',
      'The board’s title, explanations and “How it behaves” list are sign-off notes and stay in the canvas; its dashed outlines marked parts before they were built.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas }) => {
    // Owner typing: her initials and name as on her messages, three dots where her words start,
    // no fill and no bubble; screen readers hear "Maria Rivera is typing".
    const typing = canvas.getByRole('region', { name: 'Dana’s view on the public page, while Maria types' });
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

    // Her message lands from the same left edge.
    const landed = canvas.getByRole('region', { name: 'Maria’s message lands: same left edge, nothing jumps' });
    const landedAvatar = one(landed, '.cd-person-message__avatar');
    const rowLeft = (el: HTMLElement) => (el.closest('.cd-transcript-row') as HTMLElement).getBoundingClientRect().left;
    await expect(avatar.getBoundingClientRect().left - rowLeft(avatar)).toBe(landedAvatar.getBoundingClientRect().left - rowLeft(landedAvatar));

    // Maria's own screen keeps the visitor's bubble.
    const own = canvas.getByRole('region', { name: 'Maria’s own screen, Dana typing: the signed bubble, for contrast' });
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
