import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ApprovalCard } from '../components/ApprovalCard/ApprovalCard.tsx';
import { chen, rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { Panel, Sheet } from './parts.tsx';
import { SPEC } from './spec.ts';

const DANA = rivera.people.dana.name;
const PANELS = {
  limit: 'Two answers: a limit held it, so nothing saves a rule',
  askCard: 'Three answers: an ask card held it, so Deny can save a rule',
  verified: 'Four answers: a verified customer, an ask card',
} as const;

function ApprovalAnswers() {
  return (
    <Sheet title="Approval answers" gap={24}>
      <Panel label={PANELS.limit} width={588} bare>
        <ApprovalCard
          decision={rivera.decisions.held}
          heldBy={rivera.ruleCards['rv-quote'].reason}
          context={
            <>
              From the visitor: “<span data-copy="user">How much to clear a clogged drain? Can I get 15% off if I pay cash?</span>”
            </>
          }
          waiting="Web chat, 2 min ago"
          onAnswer={fn()}
        />
      </Panel>
      <Panel label={PANELS.askCard} width={588} bare>
        <ApprovalCard decision={chen.heldConsultation} heldBy={chen.ruleCards['cc-consult'].reason} waiting="Web chat, 5 min ago" onAnswer={fn()} />
      </Panel>
      <Panel label={PANELS.verified} width={588} bare>
        <ApprovalCard
          decision={rivera.heldRefund}
          heldBy={rivera.ruleCards['rv-refund'].reason}
          waiting="Web chat, 1 min ago"
          personName={DANA}
          onAnswer={fn()}
        />
      </Panel>
    </Sheet>
  );
}

const meta = {
  title: 'Boards/Approval answers',
  render: () => <ApprovalAnswers />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Answers-TwoButtons',
    canvasNote: [
      'The signed answers, option 2: Allow and Deny, each a plain button when it has one answer or a menu button when it has two, Deny in the soft red fill.',
      'Deny always is offered only when an ask card held the request, never for a limit hold; Allow only for a verified person names them.',
      'The board compares the earlier answer rows and three explorations; this sheet shows only the signed one, on the Turner and Chen & Co. fixtures’ held requests, with Deny’s menu opened on the three-answer card.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The card's answer buttons, in order, without an open menu's items. */
function answers(panel: HTMLElement): HTMLElement[] {
  return [...within(panel).getByRole('group', { name: 'Your answer' }).querySelectorAll<HTMLElement>(':scope button:not([role="menuitem"])')];
}

export const Board: Story = {
  play: async ({ canvas, userEvent }) => {
    // A limit hold: one answer a side, two plain buttons, no Deny always.
    const limit = answers(canvas.getByRole('region', { name: PANELS.limit }));
    await expect(limit.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time']);
    for (const button of limit) await expect(button).not.toHaveAttribute('aria-haspopup');
    const [allow] = limit as [HTMLElement];
    expectComputed(allow, SPEC.secondaryMain);

    // An ask card held the tool: Deny has two answers, so it is a menu button.
    const askPanel = canvas.getByRole('region', { name: PANELS.askCard });
    const ask = answers(askPanel);
    await expect(ask.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny']);
    const deny = ask[1] as HTMLElement;
    await expect(deny).toHaveAttribute('aria-haspopup', 'menu');

    // A verified customer: both sides are menus, and Allow's rule answer names her.
    const verified = answers(canvas.getByRole('region', { name: PANELS.verified }));
    await expect(verified.map((button) => button.textContent)).toEqual(['Allow', 'Deny']);
    for (const button of verified) await expect(button).toHaveAttribute('aria-haspopup', 'menu');

    // Deny's menu, open: This time and Always.
    await userEvent.click(deny);
    const menu = within(askPanel).getByRole('menu', { name: 'Deny' });
    await expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('This time'),
      expect.stringContaining('Always'),
    ]);
  },
};
