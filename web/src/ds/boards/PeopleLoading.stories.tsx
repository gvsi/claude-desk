import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';

import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Skeleton } from '../components/Skeleton/Skeleton.tsx';
import { SkeletonScreen } from '../components/Skeleton/SkeletonScreen.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { RiveraFrame } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectOwnerFrame, one } from './spec.ts';

// The shapes sit in the list's own parts, whose classes these components' styles define.
import '../components/CountPill/CountPill.css';
import '../components/PersonRow/PersonRow.css';
import '../components/SectionHeader/SectionHeader.css';

/**
 * The list's shapes, from the People list's own parts: the section's head over its hairline, its
 * title and count, then a `PersonRow` shape for each of the seed's two contacts on record.
 */
function CustomersShapes() {
  return (
    <div className="board-people__section">
      <div className="board-people__head">
        <div className="cd-section-header">
          <div className="cd-section-header__title">
            <Skeleton shape="line" text="section" width={130} />
            <Skeleton
              shape="block"
              className="cd-type-count"
              measure={{ label: '2', className: 'cd-count-pill cd-type-count', tagName: 'span' }}
              height="1lh"
              radius="full"
            />
          </div>
        </div>
      </div>
      <div className="board-people__rows">
        {['30%', '40%'].map((width) => (
          <div key={width} className="cd-person-row">
            <Skeleton shape="line" text="control" width={width} />
            <Skeleton shape="line" text="caption" width="45%" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Customers while the list loads: the real header, then the list's shapes where the list goes. */
function PeopleLoading() {
  return (
    <RiveraFrame current="people" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-filled-page">
        <div className="board-people">
          <PageHeader title="Customers" subtitle="Leads and customers on this Desk. Verified means a code reached their contact on record." />
          <SkeletonScreen loading status="Loading your customers" skeleton={<CustomersShapes />} />
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
      'Customers while the list loads. The board draws LoadingLine under a hairline where the list goes; the loading state follows P12-01 (UXC-P1201-After, #artboard-dec46cf506e4), which the owner signed on 2026-10-31, so the list is drawn as its own shapes, sweeping as one band, with the loading words in a hidden status.',
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

    // list_drawn_as_shapes_under_the_header: after the wait, the loading words in a visually hidden
    // status, and the list's shapes where the list goes, under the real header: the first section's
    // head 28 px under the header, over its hairline, then two 51 px rows 4 px under it, 2 px apart.
    const main = canvas.getByRole('main');
    const status = canvas.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/^Loading your customers$/));
    await expect(status).toHaveClass('cd-sr-only');
    await expect(one(main, '.cd-skeleton-screen__body')).toHaveAttribute('aria-busy', 'true');
    const layer = one(main, '.cd-skeleton-screen__layer');
    await expect(layer).toHaveAttribute('data-state', 'shown');
    await expect(layer).toHaveAttribute('aria-hidden', 'true');
    await expect(layer.textContent).toBe('');
    const head = one(layer, '.board-people__head');
    expectComputed(head, { borderBottomWidth: '1px', borderBottomColor: 'rgba(250, 249, 245, 0.12)', paddingBottom: '8px' });
    const header = one(main, '.cd-page-header');
    await expect(Math.round(head.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBe(28);
    const rows = [...layer.querySelectorAll<HTMLElement>('.cd-person-row')].map((row) => row.getBoundingClientRect());
    await expect(rows.map((row) => row.height)).toEqual([51, 51]);
    await expect(Math.round(rows[0]!.top - head.getBoundingClientRect().bottom)).toBe(4);
    await expect(Math.round(rows[1]!.top - rows[0]!.bottom)).toBe(2);
    for (const shape of layer.querySelectorAll<HTMLElement>('.cd-skeleton')) expectComputed(shape, { backgroundColor: 'rgba(250, 249, 245, 0.06)' });
    await expect(one(main, '.board-people').getBoundingClientRect().width).toBe(760);

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
