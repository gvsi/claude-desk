import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { ChangeReview } from '../components/ChangeReview/ChangeReview.tsx';
import { ConnectorPicker, type ConnectorPickerProps } from '../components/ConnectorPicker/ConnectorPicker.tsx';
import type { ConnectorView } from '../components/ConnectorName/ConnectorName.tsx';
import { ConnectorReview } from '../components/ConnectorReview/ConnectorReview.tsx';
import { ConnectorSignIn } from '../components/ConnectorSignIn/ConnectorSignIn.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Steps } from '../components/Steps/Steps.tsx';
import { chen, rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { BoardPage, ChenFrame, ConnectorsPage, RiveraFrame, Trail, type ConnectorsPageProps, SIDEBAR_NOTE } from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOutcomeMenus, expectOwnerFrame, expectTabOrder, one, some } from './spec.ts';

const RIVERA_COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };
const CHEN_COUNTS = { conversations: { n: 1, label: '1 live conversation' } };

const { googleCalendar } = rivera;

/** The steps of adding an app from outside, and a built-in connector. */
const APP_STEPS = ['Choose', 'Sign in', 'Review tools', 'Confirm'];
const BUILT_IN_STEPS = ['Choose', 'Review tools', 'Confirm'];

/** Chen & Co. CPA's three built-in connectors, as the signed picker boards draw its Desk. */
const CHEN_THREE = chen.connectors.sections.filter((section) => ['bookings', 'verification', 'documents'].includes(section.connector.id));

/** Chen & Co. CPA's apps, as the picker words them. */
const [CHEN_CALENDAR, CHEN_STRIPE] = chen.picker.external.map((item) => item.connector);
if (!CHEN_CALENDAR || !CHEN_STRIPE) throw new Error('The Chen picker fixture lost an app');

/**
 * Chen & Co. CPA's Connectors page behind the picker: Bookings, Verification and Documents built
 * in, nothing connected yet, and the apps it can connect.
 */
function chenConnectors(apps: readonly ConnectorView[]): ConnectorsPageProps['directory'] {
  return {
    builtInCaption: rivera.directory.builtInCaption,
    builtIn: CHEN_THREE.map((section) => ({
      connector: section.connector,
      tools: section.tools.length,
      href: section.href,
      note: section.connector.id === 'verification' ? 'Always on' : undefined,
    })),
    connected: [],
    available: apps.map((connector) => ({ connector, tools: connector.id === 'google_calendar' ? 1 : 2, onConnect: fn() })),
  };
}

/** The built-in rows of Chen's picker as the boards sign them: Payments, Quotes and Leads to add. */
const CHEN_BUILT_IN = [
  { connector: chen.connectors.views.payments, state: 'available' },
  { connector: chen.connectors.views.quotes, state: 'available' },
  { connector: chen.connectors.views.leads, state: 'available' },
  { connector: chen.connectors.views.bookings, state: 'added' },
  { connector: chen.connectors.views.documents, state: 'added' },
] satisfies ConnectorPickerProps['builtIn'];

/** The picker with Google Calendar coming soon in the demo (N-Conn-07b). */
const CHEN_PICKER_COMING_SOON = { ...chen.picker, builtIn: CHEN_BUILT_IN } satisfies Pick<ConnectorPickerProps, 'business' | 'builtIn' | 'external' | 'note'>;

/** The picker with every app to connect: Google Calendar once it works, and Stripe (N-Conn-07). */
const CHEN_PICKER_TO_CONNECT = {
  business: chen.business.name,
  builtIn: CHEN_BUILT_IN,
  external: [
    { connector: { ...CHEN_CALENDAR, description: "Lets Claude see when you're busy, never what the event is." }, state: 'available' },
    { connector: CHEN_STRIPE, state: 'available' },
  ],
} satisfies Pick<ConnectorPickerProps, 'business' | 'builtIn' | 'external'>;

const meta = {
  title: 'Boards/Add a connector',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The picker's dialog in its look, over the page: the serif title, and only its controls in the Tab order. */
async function expectPickerOver(root: HTMLElement): Promise<HTMLElement> {
  await expect(window.innerWidth).toBe(1512);
  await expectOwnerFrame(root, 'Rules');
  const dialog = await waitFor(() => within(root).getByRole('dialog', { name: 'Add a connector' }));
  expectComputed(within(dialog).getByRole('heading', { name: 'Add a connector' }), SPEC.pageTitle);
  expectComputed(dialog, { backgroundColor: 'rgb(42, 41, 39)', borderTopLeftRadius: '12px' });
  for (const tile of some(dialog, '.cd-connector-icon')) {
    expectComputed(tile, tile.classList.contains('cd-connector-icon--brand') ? CONNECTORS_SPEC.brandTile : CONNECTORS_SPEC.iconTile);
  }
  await expect(expectMockBesideExternalNames(dialog)).toBeGreaterThanOrEqual(1);
  await expect(within(dialog).getByText('Mock connectors stand in for the real apps. No account is used and nothing is sent to them.')).toBeVisible();
  // Verification is never offered: every Desk has it.
  await expect(within(dialog).queryByText('Verification')).toBeNull();
  return dialog;
}

/** Tab from the dialog's first control: it walks only the dialog's controls, in order, and wraps. */
async function expectTabStaysIn(dialog: HTMLElement, user: { tab: () => Promise<void> }, stops: HTMLElement[]): Promise<void> {
  await expect(stops[0]).toHaveFocus();
  for (const stop of [...stops.slice(1), stops[0]]) {
    await user.tab();
    await expect(stop).toHaveFocus();
  }
  await expect(dialog.contains(document.activeElement)).toBe(true);
}

export const ComingSoon: Story = {
  name: 'Add a connector, coming soon',
  render: () => (
    <ChenFrame current="rules" counts={CHEN_COUNTS}>
      <ConnectorsPage directory={chenConnectors([CHEN_STRIPE])} />
      <ConnectorPicker {...CHEN_PICKER_COMING_SOON} onChoose={fn()} onClose={fn()} />
    </ChenFrame>
  ),
  parameters: {
    canvas: 'N-Conn-07b-Add-Picker-ComingSoon',
    canvasNote: [
      'Chen & Co. CPA’s picker as the board draws it, over Chen’s Connectors page with its three built-in connectors, where the redrawn board puts Turner Plumbing’s page and sidebar behind Chen’s picker.',
      'Verification is never listed, since every Desk has it, where the board lists it as “Always on”; the mock line also shows under the coming-soon note; the picker has a Close button the board doesn’t draw.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const dialog = await expectPickerOver(canvasElement);
    await expect(within(dialog).getByText('Coming soon in this demo')).toBeVisible();
    await expect(within(dialog).queryByRole('button', { name: 'Connect Google Calendar' })).toBeNull();
    await expect(within(dialog).getAllByText('Added')).toHaveLength(2);
    await expect(within(dialog).getByText(chen.picker.note)).toBeVisible();
    // focus_order_is_logical: only the dialog's controls, from "Add Payments".
    await expectTabStaysIn(dialog, userEvent, [
      within(dialog).getByRole('button', { name: 'Add Payments' }),
      within(dialog).getByRole('button', { name: 'Add Quotes' }),
      within(dialog).getByRole('button', { name: 'Add Leads and callbacks' }),
      within(dialog).getByRole('button', { name: 'Connect Stripe' }),
      within(dialog).getByRole('button', { name: 'Close' }),
    ]);
  },
};

export const Picker: Story = {
  name: 'Add a connector',
  render: () => (
    <ChenFrame current="rules" counts={CHEN_COUNTS}>
      <ConnectorsPage directory={chenConnectors([CHEN_CALENDAR, CHEN_STRIPE])} />
      <ConnectorPicker {...CHEN_PICKER_TO_CONNECT} onChoose={fn()} onClose={fn()} />
    </ChenFrame>
  ),
  parameters: {
    canvas: 'N-Conn-07-Add-Picker',
    canvasNote: [
      'Chen & Co. CPA’s picker as the board draws it: Payments, Quotes and Leads and callbacks to add, Bookings and Documents added, and Google Calendar and Stripe to connect. Google Calendar is catalog-only in the demo, so this shows the picker once it works.',
      'Verification is never listed, since every Desk has it, where the board lists it as “Always on”; the picker has a Close button the board doesn’t draw; the connectors’ lines are the fixture’s.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const dialog = await expectPickerOver(canvasElement);
    await expect(within(dialog).getByText(/^Add what fits Chen & Co\. CPA\./)).toBeVisible();
    // The signed state: Payments, Quotes and Leads and callbacks to add, Bookings and Documents
    // added, Google Calendar and Stripe to connect; Verification never listed.
    const builtIn = within(dialog).getByRole('list', { name: 'Claude Desk' });
    const rows = within(builtIn).getAllByRole('listitem');
    await expect(rows.map((row) => row.querySelector('.cd-connector-name__name')?.textContent)).toEqual([
      'Payments',
      'Quotes',
      'Leads and callbacks',
      'Bookings',
      'Documents',
    ]);
    await expect(within(dialog).getAllByText('Added')).toHaveLength(2);
    await expect(within(dialog).queryByText('Coming soon in this demo')).toBeNull();
    await expect(within(dialog).queryByText(chen.picker.note)).toBeNull();
    // focus_order_is_logical: only the dialog's controls, from "Add Payments" to Close.
    await expectTabStaysIn(dialog, userEvent, [
      within(dialog).getByRole('button', { name: 'Add Payments' }),
      within(dialog).getByRole('button', { name: 'Add Quotes' }),
      within(dialog).getByRole('button', { name: 'Add Leads and callbacks' }),
      within(dialog).getByRole('button', { name: 'Connect Google Calendar' }),
      within(dialog).getByRole('button', { name: 'Connect Stripe' }),
      within(dialog).getByRole('button', { name: 'Close' }),
    ]);
  },
};

/** The sign-in step as the screen holds it: the choice follows the radios. */
function SignIn() {
  const [value, setValue] = useState(googleCalendar.signIn.value);
  return (
    <ConnectorSignIn
      connector={googleCalendar.view}
      promise={{ title: googleCalendar.promise.title }}
      {...googleCalendar.signIn}
      value={value}
      onChange={setValue}
      onContinue={fn()}
      onCancel={fn()}
    />
  );
}

export const ConnectGoogleCalendar: Story = {
  name: 'Connect Google Calendar',
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <ConnectorsPage directory={{ ...rivera.directory, available: rivera.directory.available.map(({ connector, tools }) => ({ connector, tools, onConnect: fn() })) }} />
      <SignIn />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-08-GCal-SignIn',
    canvasNote: ['Google Calendar is catalog-only in the demo, so this shows its mock sign-in once it works. It asks for no account details.', SIDEBAR_NOTE].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const dialog = await waitFor(() => within(canvasElement).getByRole('dialog', { name: /^Connect Google Calendar/ }));
    await expect(expectMockBesideExternalNames(dialog)).toBeGreaterThanOrEqual(1);
    // Step 2 of 4, the current step's circle filled.
    const steps = within(dialog).getByRole('list', { name: 'Connect Google Calendar' });
    const current = one(steps, '[aria-current="step"]');
    await expect(current).toHaveTextContent('Sign in');
    expectComputed(one(current, '.cd-steps__circle'), { ...CONNECTORS_SPEC.stepCircle, ...CONNECTORS_SPEC.currentStep });
    // sign_in_collects_nothing: radios only.
    const inputs = [...dialog.querySelectorAll('input')];
    await expect(inputs.every((input) => input.type === 'radio')).toBe(true);
    const [jobs, personal] = within(dialog).getAllByRole('radio');
    await expect(jobs).toBeChecked();
    // focus_order_is_logical: only the dialog's controls: the choices as one stop, Cancel, Continue.
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const next = within(dialog).getByRole('button', { name: 'Continue' });
    expectComputed(next, SPEC.primary);
    (jobs as HTMLElement).focus();
    await userEvent.tab();
    await expect(cancel).toHaveFocus();
    await userEvent.tab();
    await expect(next).toHaveFocus();
    await userEvent.tab();
    await expect(dialog.contains(document.activeElement)).toBe(true);
    void personal;
  },
};

/** The review's header and tools: a 44 px tile, hairlines between tools, 14 px above and below. */
function expectReviewLook(main: HTMLElement): void {
  expectComputed(one(main, '.cd-connector-review__header > .cd-connector-icon'), { width: '44px', height: '44px' });
  for (const [index, tool] of some(main, '.cd-connector-review__tool').entries()) {
    expectComputed(tool, { paddingTop: '14px', paddingBottom: '14px', borderTopWidth: index === 0 ? '0px' : '1px' });
    if (index > 0) expectComputed(tool, { borderTopColor: 'rgba(250, 249, 245, 0.12)' });
  }
}

/** A review page's frame: the trail and the steps above the review. */
async function expectAddStep(root: HTMLElement, trail: string[], steps: string[], current: string): Promise<HTMLElement> {
  await expect(window.innerWidth).toBe(1512);
  await expectOwnerFrame(root, 'Rules');
  const main = within(root).getByRole('main');
  const crumbs = within(main).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(within(crumbs).getAllByRole('link').map((link) => link.textContent)).toEqual(trail.slice(0, -1));
  const list = one(main, '.cd-steps');
  await expect([...list.querySelectorAll('.cd-steps__name')].map((name) => name.textContent?.replace(', done', ''))).toEqual(steps);
  const step = one(list, '[aria-current="step"]');
  await expect(step).toHaveTextContent(current);
  expectComputed(one(step, '.cd-steps__circle'), { ...CONNECTORS_SPEC.stepCircle, ...CONNECTORS_SPEC.currentStep });
  for (const circle of some(list, '.cd-steps__circle')) expectComputed(circle, CONNECTORS_SPEC.stepCircle);
  await expectFooter(root);
  return main;
}

export const ReviewGoogleCalendar: Story = {
  name: 'Review Google Calendar',
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Google Calendar']} />
        <Steps label="Connect Google Calendar" steps={APP_STEPS} current={2} />
        <ConnectorReview
          connector={googleCalendar.view}
          intro={googleCalendar.review.intro}
          tools={googleCalendar.review.tools}
          onChangeOutcome={fn()}
          onTurnOn={fn()}
          onCancel={fn()}
        />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-09-GCal-Review',
    canvasNote: [
      'Google Calendar is catalog-only in the demo, so this shows its review once it works.',
      'Every new tool starts at Ask me first, with the rules that cover it shown; none of Mike’s covers this one yet, as the board says.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const main = await expectAddStep(canvasElement, ['Connectors', 'Google Calendar'], APP_STEPS, 'Review tools');
    // Google Calendar is named with its Mock badge on the page; the trail names it as the board does.
    await expect(expectMockBesideExternalNames(one(main, '.cd-connector-review'))).toBe(1);
    expectReviewLook(main);
    const [menu] = expectOutcomeMenus(main);
    await expect(menu).toHaveTextContent('Ask me first');
    await expect(within(main).getByText('No rule of yours covers this yet, so it starts at Ask me first.')).toBeVisible();
    const turnOn = within(main).getByRole('button', { name: 'Turn it on' });
    expectComputed(turnOn, SPEC.primary);
    // focus_order_is_logical: the trail, the outcome menus, then Turn it on and Cancel.
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...crumbs, menu as HTMLElement, turnOn, within(main).getByRole('button', { name: 'Cancel' })]);
  },
};

export const TurnOnGoogleCalendar: Story = {
  name: 'Turn on Google Calendar',
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Google Calendar']} />
        <Steps label="Connect Google Calendar" steps={APP_STEPS} current={3} />
        <PageHeader title="Turn on Google Calendar" subtitle="Here’s exactly what changes on your Desk. Nothing changes until you confirm." />
        <ChangeReview
          rows={googleCalendar.changes.rows}
          checks={googleCalendar.changes.checks}
          confirmLabel="Confirm and turn on"
          cancelLabel="Back"
          onConfirm={fn()}
          onCancel={fn()}
        />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-10-GCal-Confirm',
    canvasNote: [
      'Google Calendar is catalog-only in the demo, so this shows its proved change once it works.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const main = await expectAddStep(canvasElement, ['Connectors', 'Google Calendar'], APP_STEPS, 'Confirm');
    expectComputed(within(main).getByRole('heading', { level: 1, name: 'Turn on Google Calendar' }), SPEC.pageTitle);
    // A tag per row in words, in the change tag's look: "Added" at its 64 px floor, "Changed" as
    // wide as its word in caption type.
    const tags = some(main, '.cd-change-review__tag');
    await expect(tags.map((tag) => tag.textContent)).toEqual(['Added', 'Changed']);
    const { width: _width, ...tagLook } = CONNECTORS_SPEC.changeTag;
    for (const [index, tag] of tags.entries()) expectComputed(tag, { ...tagLook, width: index === 0 ? '64px' : '66px' });
    // The changed row's two sides, in the board's words.
    const before = one(main, '.cd-change-review__side--before');
    const after = some(main, '.cd-change-review__side--after').at(-1) as HTMLElement;
    await expect(within(before).getByText('Open times from your opening hours.')).toBeVisible();
    await expect(within(after).getByText('Open times from your opening hours, skipping anything already on your calendar.')).toBeVisible();
    await expect(within(main).getByText('Checked before you confirm')).toBeVisible();
    const confirm = within(main).getByRole('button', { name: 'Confirm and turn on' });
    expectComputed(confirm, SPEC.primary);
    await expect(confirm).toBeEnabled();
    const back = within(main).getByRole('button', { name: 'Back' });
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...crumbs, confirm, back]);
  },
};

export const ReviewPayments: Story = {
  name: 'Review Payments',
  render: () => (
    <ChenFrame current="rules" counts={CHEN_COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Payments']} />
        <Steps label="Add Payments" steps={BUILT_IN_STEPS} current={1} />
        <ConnectorReview connector={chen.connectors.views.payments} tools={chen.paymentsReview.tools} onChangeOutcome={fn()} onTurnOn={fn()} onCancel={fn()} />
      </BoardPage>
    </ChenFrame>
  ),
  parameters: {
    canvas: 'N-Conn-11b-Payments-Review',
    canvasNote: [
      'Chen & Co. CPA adding Payments, a built-in connector: no sign-in step.',
      'Each tool shows the always-on rule that covers it, “No money moves without your rule or a signed limit”, where the board says none of the owner’s rules covers it yet.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const main = await expectAddStep(canvasElement, ['Connectors', 'Payments'], BUILT_IN_STEPS, 'Review tools');
    await expect(within(main).getByText("A built-in connector, so there's nothing to sign in to. Nothing runs until you turn it on.")).toBeVisible();
    expectReviewLook(main);
    // review_starts_at_ask_me_first: both tools at Ask me first.
    const menus = expectOutcomeMenus(main);
    await expect(menus.map((menu) => menu.textContent)).toEqual(['Ask me first', 'Ask me first']);
    const turnOn = within(main).getByRole('button', { name: 'Turn it on' });
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...crumbs, ...menus, turnOn, within(main).getByRole('button', { name: 'Cancel' })]);
  },
};
