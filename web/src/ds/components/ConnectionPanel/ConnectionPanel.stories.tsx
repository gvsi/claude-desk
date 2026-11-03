import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectionPanel, type ConnectionPanelProps } from './ConnectionPanel.tsx';

const { views } = rivera.connectors;
const payments = rivera.paymentsConnection;
const stripe = rivera.stripeConnection;

const meta = {
  title: 'Connectors/ConnectionPanel',
  component: ConnectionPanel,
  args: {
    connector: views.payments,
    off: { kind: 'turn_off', consequence: payments.consequence, stops: payments.stops, onTurnOff: fn() },
  },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectionPanel {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-02-Payments',
    canvasNote:
      'The line says the change shows before it applies, which the plain confirm does; the confirm lists the tools that stop and the rules that stop applying, where the board lists the rules in the line.',
  },
} satisfies Meta<typeof ConnectionPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `turn_off` form of the story's `off`, for its callback. */
function turnOff(args: ConnectionPanelProps) {
  if (args.off.kind !== 'turn_off') throw new Error('Expected a connector that can be turned off');
  return args.off;
}

export const TurnOffPayments: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const off = turnOff(args);
    // The panel: its heading, the consequence and what stays, and a secondary button.
    await expect(canvas.getByRole('heading', { level: 2, name: 'Turn off Payments' })).toBeVisible();
    await expect(
      canvas.getByText(`${payments.consequence} You'll see the change before it applies. Your rules are kept, so you can add it back.`),
    ).toBeVisible();
    const button = canvas.getByRole('button', { name: 'Turn off Payments' });
    expectComputed(button, { backgroundColor: 'rgba(250, 249, 245, 0.1)', height: '40px' });

    // turn_off_confirms_first: the button opens a plain confirm, named by its question, that lists
    // the tools that stop and the rules that stop applying.
    await userEvent.click(button);
    const dialog = await canvas.findByRole('dialog', { name: 'Turn off Payments?' });
    await expect(within(dialog).getByText('These tools stop at once:')).toBeVisible();
    for (const tool of ['Payment link', 'Charge within a signed limit']) await expect(within(dialog).getByText(tool)).toBeVisible();
    await expect(within(dialog).getByText('These rules stop applying:')).toBeVisible();
    for (const rule of payments.stops.rules) await expect(within(dialog).getByText(rule)).toBeVisible();
    await expect(within(dialog).getByText('Your rules are kept, so you can add it back.')).toBeVisible();
    // "Keep it on" closes it with no call.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it on' }));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(off.onTurnOff).not.toHaveBeenCalled();
    await expect(button).toHaveFocus();
    // Escape closes it with no call too.
    await userEvent.click(button);
    await canvas.findByRole('dialog', { name: 'Turn off Payments?' });
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(off.onTurnOff).not.toHaveBeenCalled();
    // Opened again, its "Turn off Payments" turns it off once over two clicks, and the dialog waits.
    await userEvent.click(button);
    const again = await canvas.findByRole('dialog', { name: 'Turn off Payments?' });
    const confirm = within(again).getByRole('button', { name: 'Turn off Payments' });
    await userEvent.click(confirm);
    await userEvent.click(confirm);
    await expect(off.onTurnOff).toHaveBeenCalledTimes(1);
    await expect(again).toHaveAttribute('aria-busy', 'true');
  },
};

export const DisconnectStripe: Story = {
  args: {
    connector: views.stripe,
    details: stripe.details,
    off: { kind: 'turn_off', consequence: stripe.consequence, stops: stripe.stops, onTurnOff: fn() },
  },
  parameters: {
    canvas: 'N-Conn-03-Stripe',
    canvasNote: 'The line says the change shows before it applies, which the plain confirm does.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const off = turnOff(args);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Connection' })).toBeVisible();
    // The details as a description list: a term and its value on each row, under a hairline.
    const list = canvasElement.querySelector('dl');
    if (list === null) throw new Error('No details list');
    const terms = [...list.querySelectorAll('dt')].map((term) => term.textContent);
    const values = [...list.querySelectorAll('dd')].map((value) => value.textContent);
    await expect(terms).toEqual(stripe.details.map((detail) => detail.label));
    await expect(values).toEqual(stripe.details.map((detail) => detail.value));
    const row = list.querySelector('dt')?.parentElement;
    if (!row) throw new Error('No details row');
    expectComputed(row, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    expectComputed(list.querySelector('dt') as Element, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(
      canvas.getByText(`${stripe.consequence} You'll see the change before it applies. Your rules for them are kept in case you connect again.`),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Disconnect' }));
    const dialog = await canvas.findByRole('dialog', { name: 'Disconnect Stripe? Mock' });
    // The dialog names Stripe with its Mock badge.
    await expect(expectMockBesideExternalNames(dialog)).toBe(1);
    for (const tool of stripe.stops.tools) await expect(within(dialog).getByText(tool)).toBeVisible();
    for (const rule of stripe.stops.rules) await expect(within(dialog).getByText(rule)).toBeVisible();
    await expect(within(dialog).getByText('Your rules for them are kept in case you connect again.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it connected' }));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Disconnect' }));
    const again = await canvas.findByRole('dialog', { name: 'Disconnect Stripe? Mock' });
    await userEvent.click(within(again).getByRole('button', { name: 'Disconnect' }));
    await expect(off.onTurnOff).toHaveBeenCalledTimes(1);
  },
};

export const DisconnectGoogleCalendar: Story = {
  args: {
    connector: rivera.googleCalendar.view,
    details: rivera.googleCalendar.connection.details,
    off: {
      kind: 'turn_off',
      consequence: rivera.googleCalendar.connection.consequence,
      stops: rivera.googleCalendar.connection.stops,
      onTurnOff: fn(),
    },
  },
  parameters: {
    canvas: 'N-Conn-04-GoogleCalendar',
    canvasNote:
      'Google Calendar is catalog-only in the demo, so this shows what the panel supports once it works. The line says the change shows first, which the plain confirm does.',
  },
  play: async ({ canvas, userEvent }) => {
    const terms = canvas.getAllByRole('term').map((term) => term.textContent);
    await expect(terms).toEqual(['Calendar', 'Connected', 'Tool definitions']);
    await userEvent.click(canvas.getByRole('button', { name: 'Disconnect' }));
    const dialog = await canvas.findByRole('dialog', { name: 'Disconnect Google Calendar? Mock' });
    await expect(within(dialog).getByText("See when you're free")).toBeVisible();
    await expect(within(dialog).getByText('Keep it connected', { selector: 'button *' })).toBeVisible();
  },
};

/** The screen while it turns a connector off: `pending` from its confirm until the screen says it is done. */
const screen = { finish: () => {} };

function TurningOff(args: ConnectionPanelProps) {
  const [pending, setPending] = useState(false);
  screen.finish = () => setPending(false);
  const off = turnOff(args);
  return (
    <div style={{ maxWidth: 960 }}>
      <ConnectionPanel
        {...args}
        off={{
          ...off,
          pending,
          onTurnOff: () => {
            off.onTurnOff();
            setPending(true);
          },
        }}
      />
    </div>
  );
}

export const Pending: Story = {
  args: {
    off: { kind: 'turn_off', consequence: payments.consequence, stops: { tools: payments.stops.tools, rules: [] }, onTurnOff: fn() },
  },
  render: (args) => <TurningOff {...args} />,
  parameters: {
    canvasNote:
      'The plain confirm while Payments turns off, here with no rule that stops applying; no board draws the dialog. The screen passes pending from the confirm until it is done.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const off = turnOff(args);
    const button = canvas.getByRole('button', { name: 'Turn off Payments' });
    await userEvent.click(button);
    const dialog = await canvas.findByRole('dialog', { name: 'Turn off Payments?' });
    // With no rule that stops applying, the dialog says so.
    await expect(within(dialog).getByText('None of your rules stop applying.')).toBeVisible();
    await expect(within(dialog).queryByText('These rules stop applying:')).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Turn off Payments' });
    await userEvent.click(confirm);
    await expect(off.onTurnOff).toHaveBeenCalledTimes(1);
    // While pending: the dialog is busy, the pressed button spins, the other waits, Escape does nothing.
    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(confirm.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    const keep = within(dialog).getByRole('button', { name: 'Keep it on' });
    await expect(keep).toHaveAttribute('aria-disabled', 'true');
    await expect(keep.querySelector('.cd-button__spinner')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(keep);
    await expect(canvas.getByRole('dialog', { name: 'Turn off Payments?' })).toBeVisible();
    await expect(off.onTurnOff).toHaveBeenCalledTimes(1);
    // When the screen is done, the dialog goes, and the panel's button works again.
    screen.finish();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await expect(button).not.toHaveAttribute('aria-disabled');
    await userEvent.click(button);
    await expect(await canvas.findByRole('dialog', { name: 'Turn off Payments?' })).not.toHaveAttribute('aria-busy');
  },
};

export const VerificationAlwaysOn: Story = {
  args: { connector: views.verification, off: { kind: 'always_on', reason: rivera.verificationConnection.reason } },
  parameters: {
    canvas: 'none',
    canvasNote: "No board draws Verification's page; the owner decided its words. Verification is always on, so it has no button to turn it off.",
  },
  play: async ({ canvas }) => {
    // always_on_has_no_turn_off
    const line = canvas.getByText("Always on. It's how Claude confirms a customer before sharing anything private.");
    await expect(line).toBeVisible();
    await expect(canvas.queryByRole('button')).toBeNull();
    // The line is as tall as its words, one line here: no room is kept for a button beside it.
    await expect(line.getBoundingClientRect().height).toBe(parseFloat(getComputedStyle(line).lineHeight));
  },
};
