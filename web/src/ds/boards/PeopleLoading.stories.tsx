import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { LoadingLine } from '../components/LoadingLine/LoadingLine.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { RiveraFrame } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectOwnerFrame, one } from './spec.ts';

/** Customers while the list loads: the header, a hairline, and the loading line where the list goes. */
function PeopleLoading() {
  return (
    <RiveraFrame current="people" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-filled-page">
        <div className="board-people">
          <PageHeader title="Customers" subtitle="Leads and customers on this Desk. Verified means a code reached their contact on record." />
          <div className="board-people__loading">
            <LoadingLine>Loading your customers</LoadingLine>
          </div>
          <ConceptFooter />
        </div>
      </div>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Customers, loading',
  render: () => <PeopleLoading />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-People-Loading',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'Customers while the list loads: LoadingLine under a hairline where the list goes, in the 760 px column of the People list.',
      'The board’s sidebar has the Connectors row, which belongs to another change, so the nav ends a row higher here.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Customers', { fill: true });
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Customers' }), SPEC.pageTitle);

    // loading_line_under_the_header: one status, the words saying what is loading, 16 px under a
    // hairline that sits 28 px under the header, where the list's first section head would be.
    const main = canvas.getByRole('main');
    const line = canvas.getByRole('status');
    await expect(line).toHaveTextContent(/^Loading your customers$/);
    const area = one(main, '.board-people__loading');
    expectComputed(area, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)', paddingTop: '16px' });
    const header = one(main, '.cd-page-header');
    await expect(Math.round(area.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBe(28);
    await expect(Math.round(line.getBoundingClientRect().left)).toBe(Math.round(area.getBoundingClientRect().left));
    await expect(one(main, '.board-people').getBoundingClientRect().width).toBe(760);

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
