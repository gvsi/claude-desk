import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Card } from '../components/Card/Card.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { SettingsPage, VisionNote } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectSettingsPage, one } from './spec.ts';

/** Settings › Billing: a vision note and the plan. */
function SettingsBilling() {
  return (
    <SettingsPage current="billing">
      <VisionNote>Nothing is billed in this prototype.</VisionNote>
      <Card as="section" label="Plan">
        <h2 className="cd-type-section">Plan</h2>
        <p className="board-settings__plan-line cd-type-body">One business, up to three Desks.</p>
        <p className="board-settings__plan-line board-quiet cd-type-meta">Billing would live here, with usage per Desk.</p>
      </Card>
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, billing',
  render: () => <SettingsBilling />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Billing',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Settings › Billing: a Pill marks it as vision, then the plan in a Card, its name a heading where the board sets it as a line in the same type.',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, like every other owner page (owner decision, 2026-10-30), so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const content = await expectSettingsPage(canvasElement, 'Billing');
    const page = within(canvas.getByRole('main'));

    const vision = one(content, '.board-settings__vision');
    await expect(vision).toHaveTextContent(/^MockNothing is billed in this prototype\.$/);

    // The plan, 20 px under the note: its name, then each line 8 px under the one before.
    const plan = page.getByRole('region', { name: 'Plan' });
    expectComputed(plan, SPEC.card);
    await expect(Math.round(plan.getBoundingClientRect().top - vision.getBoundingClientRect().bottom)).toBe(20);
    const name = within(plan).getByRole('heading', { level: 2, name: 'Plan' });
    expectComputed(name, { fontSize: '15px', lineHeight: '20px', fontWeight: '520' });
    const offer = within(plan).getByText('One business, up to three Desks.');
    const later = within(plan).getByText('Billing would live here, with usage per Desk.');
    expectComputed(offer, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(later, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(offer.getBoundingClientRect().top - name.getBoundingClientRect().bottom)).toBe(8);
    await expect(Math.round(later.getBoundingClientRect().top - offer.getBoundingClientRect().bottom)).toBe(8);
    // 20 px padding, the three lines, and the 1 px border: 116 px.
    await expect(Math.round(plan.getBoundingClientRect().height)).toBe(116);
    await expect(within(content).queryByRole('button')).toBeNull();

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
