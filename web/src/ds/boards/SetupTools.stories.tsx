import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { SetupToolsList, type SetupToolsRow } from '../components/SetupToolsList/SetupToolsList.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { SetupFrame } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectTabOrder, footerLink } from './spec.ts';

const { views } = rivera.connectors;

/** Turner Plumbing's tools step as the board draws it: four built in, two to add, Stripe and its two tools to connect. */
const BUILT_IN: SetupToolsRow[] = [
  { connector: views.quotes, state: 'on' },
  { connector: views.bookings, state: 'on' },
  { connector: views.leads, state: 'on' },
  { connector: views.verification, state: 'always_on' },
  { connector: views.documents, state: 'off', onChoose: fn() },
  { connector: views.payments, state: 'off', onChoose: fn() },
];
const EXTERNAL: SetupToolsRow[] = [{ connector: views.stripe, state: 'off', tools: 2, onChoose: fn() }];

function SetupTools() {
  const business = rivera.business.name;
  return (
    <SetupFrame business={business}>
      <PageHeader
        title="What Claude can use"
        subtitle={`Built-in connectors are part of Claude Desk. Add the ones that fit ${business}; each tool starts at Ask me first unless one of your rules covers it, and you review it before it turns on.`}
      />
      <div className="board-setup__stack">
        <SetupToolsList builtIn={BUILT_IN} external={EXTERNAL} />
        <div className="board-setup__actions">
          <Button variant="primary" size="main" onClick={fn()}>
            Continue
          </Button>
        </div>
      </div>
    </SetupFrame>
  );
}

const meta = {
  title: 'Boards/Setup, tools',
  render: () => <SetupTools />,
  // Drawn at a 14-inch laptop's width and the page's own 1100 px, so the play measures it there.
  globals: { viewport: { value: 'laptop-1100', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Setup-05-Tools',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The setup interview’s tools step: the two cards and their rows are SetupToolsList, each row’s status or button at its right.',
      'The board draws Quotes with a bookmark, Leads and callbacks with a phone and Documents with the page Quotes has on the Connectors boards; the rows use ConnectorIcon, the connectors’ icons on every other board.',
      'The connectors’ lines are the fixtures’, with straight apostrophes where the board sets curly ones.',
      'The board draws 3 tools; Stripe has two, as on the Connectors boards.',
      'The subtitle sits 4 px under the title, as PageHeader sets it on every page, where the board draws 6 px, so what follows sits 2 px higher.',
      'The step list in the bar (“Questions, Tools, Rules, Safety check, Live”) is left out of the setup frame, as on the other setup board stories; the bar, the column and “Continue” are page layout the web app (plan 04) owns.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 1100]);
    const title = canvas.getByRole('heading', { level: 1, name: 'What Claude can use' });
    expectComputed(title, SPEC.pageTitle);

    // The two cards 20 px under the header, 720 px wide in the column, 20 px apart. (The header's
    // subtitle sits 4 px under its title, PageHeader's gap, where the board draws 6 px, so the
    // cards sit 2 px higher than the render: at 201 px and 675 px, not 203 and 677.)
    const builtIn = canvas.getByRole('region', { name: 'Built in' });
    const yours = canvas.getByRole('region', { name: 'Connect your own' });
    const header = title.closest('header')!;
    const top = builtIn.getBoundingClientRect();
    await expect(Math.round(top.top - header.getBoundingClientRect().bottom)).toBe(20);
    await expect([Math.round(top.left), Math.round(top.top), Math.round(top.width), Math.round(top.height)]).toEqual([396, 201, 720, 454]);
    await expect(Math.round(yours.getBoundingClientRect().top)).toBe(675);
    expectComputed(builtIn, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });

    // Where each connector stands, or its button; no row is a link, and the footer's author name is the page's one link.
    const ends = (region: HTMLElement) => within(region).getAllByRole('listitem').map((row) => row.querySelector('.cd-setup-tools__end'));
    await expect(ends(builtIn).map((end) => end?.querySelector('.cd-status-dot') !== null)).toEqual([true, true, true, true, false, false]);
    await expect(canvas.queryAllByRole('link')).toEqual([footerLink(canvasElement)]);
    await expect(expectMockBesideExternalNames(yours)).toBe(1);
    // Stripe brings its two tools, as on the Connectors boards, where this board draws three.
    await expect(within(yours).getByText('2 tools')).toBeVisible();

    // "Continue", the one primary, 20 px under the cards.
    const continueButton = canvas.getByRole('button', { name: 'Continue' });
    expectComputed(continueButton, SPEC.primary);
    await expect(Math.round(continueButton.getBoundingClientRect().top - yours.getBoundingClientRect().bottom)).toBe(20);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: Save and exit, the rows' buttons in order, then Continue.
    await expectTabOrder(userEvent, [
      canvas.getByRole('button', { name: 'Save and exit' }),
      canvas.getByRole('button', { name: 'Add Documents' }),
      canvas.getByRole('button', { name: 'Add Payments' }),
      canvas.getByRole('button', { name: 'Connect Stripe' }),
      continueButton,
    ]);
  },
};
