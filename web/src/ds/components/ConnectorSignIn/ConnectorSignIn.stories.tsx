import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorSignIn, type ConnectorSignInProps } from './ConnectorSignIn.tsx';

const { googleCalendar } = rivera;

/** The add flow's sign-in step: the screen keeps the choice. */
function SignInStep(props: ConnectorSignInProps) {
  const [value, setValue] = useState(props.value);
  return (
    <ConnectorSignIn
      {...props}
      value={value}
      onChange={(id) => {
        props.onChange(id);
        setValue(id);
      }}
    />
  );
}

const meta = {
  title: 'Connectors/ConnectorSignIn',
  component: ConnectorSignIn,
  args: {
    connector: googleCalendar.view,
    promise: { title: googleCalendar.promise.title },
    ...googleCalendar.signIn,
    onChange: fn(),
    onContinue: fn(),
    onCancel: fn(),
  },
  render: (args) => <SignInStep {...args} />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Conn-08-GCal-SignIn',
    canvasNote: 'Google Calendar is catalog-only in the demo, so this shows what the sign-in supports once it works.',
  },
} satisfies Meta<typeof ConnectorSignIn>;

export default meta;

type Story = StoryObj<typeof meta>;

export const GoogleCalendar: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A modal dialog named by its title, "Connect Google Calendar" with its Mock badge.
    const dialog = canvas.getByRole('dialog', { name: 'Connect Google Calendar Mock' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(expectMockBesideExternalNames(dialog)).toBe(1);
    expectComputed(within(dialog).getByRole('heading', { level: 2 }), { fontFamily: '"Source Serif 4", Georgia, serif', fontSize: '26px' });
    // The steps at the top, on "Sign in".
    const steps = within(dialog).getByRole('list', { name: 'Connect Google Calendar' });
    await expect(within(steps).getByText('Sign in').closest('li')).toHaveAttribute('aria-current', 'step');
    // sign_in_collects_nothing: the mock line names Google, then the promise.
    await expect(
      within(dialog).getByText('A mock sign-in. No Google account is used, and nothing is read from or sent to Google.'),
    ).toBeVisible();
    await expect(within(dialog).getByRole('group', { name: googleCalendar.promise.title })).toBeVisible();
    // The only inputs are radios: no text, email or password field.
    const inputs = [...dialog.querySelectorAll('input, textarea, select, [contenteditable]')];
    await expect(inputs.length).toBe(args.choices.length);
    for (const input of inputs) await expect(input).toHaveAttribute('type', 'radio');
    await expect(dialog.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], textarea')).toHaveLength(0);
    // A radio group named by the question, one choice per option, the screen's value checked and focused.
    const group = within(dialog).getByRole('radiogroup', { name: "Which calendar shows when you're busy?" });
    const jobs = within(group).getByRole('radio', { name: /^Turner Plumbing jobs/ });
    const personal = within(group).getByRole('radio', { name: /^Personal/ });
    await expect(jobs).toBeChecked();
    await expect(jobs).toHaveFocus();
    await expect(jobs).toHaveAccessibleName('Turner Plumbing jobs mike@turnerplumbing.example');
    // The dialog's initial focus can count as keyboard focus. Read the selected border away from
    // focus, after its transition finishes. Native pointer and keyboard styles are covered in
    // focus.browser.test.tsx, since synthetic clicks don't set the browser's focus modality.
    jobs.blur();
    await waitFor(() => expectComputed(jobs.closest('label') as Element, { borderTopColor: 'rgb(126, 174, 218)' }));
    // Choosing another calls onChange; Continue sends the screen's value.
    await userEvent.click(personal);
    await expect(args.onChange).toHaveBeenCalledWith('personal');
    await userEvent.click(jobs);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await expect(args.onContinue).toHaveBeenCalledTimes(1);
    await expect(args.onContinue).toHaveBeenCalledWith('rivera-jobs');
    // Tab stays inside: the radios, Cancel, Continue, then back.
    jobs.focus();
    await userEvent.tab();
    await expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.tab();
    await expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveFocus();
    await userEvent.tab();
    await expect(jobs).toHaveFocus();
    // Cancel and Escape cancel.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    jobs.focus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onCancel).toHaveBeenCalledTimes(2);
  },
};

export const NothingChosen: Story = {
  args: { value: '' },
  parameters: { canvasNote: 'The sign-in before a calendar is chosen; Continue waits for a choice. No board draws it.' },
  play: async ({ args, canvas, userEvent }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Connect Google Calendar Mock' });
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    await expect(continueButton).toBeDisabled();
    for (const radio of within(dialog).getAllByRole('radio')) await expect(radio).not.toBeChecked();
    // Focus starts on the first choice.
    await expect(within(dialog).getAllByRole('radio')[0]).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Personal/ }));
    await expect(continueButton).toBeEnabled();
    await userEvent.click(continueButton);
    await expect(args.onContinue).toHaveBeenCalledWith('personal');
  },
};

export const ContinueOnce: Story = {
  parameters: { canvasNote: 'Continue while the screen connects the calendar; no board draws it.' },
  play: async ({ args, canvas }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Connect Google Calendar Mock' });
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    // sign_in_continues_once: two presses in the same moment send once, and Continue spins,
    // keeping its name, until the screen answers.
    continueButton.click();
    continueButton.click();
    await expect(args.onContinue).toHaveBeenCalledTimes(1);
    await expect(args.onContinue).toHaveBeenCalledWith('rivera-jobs');
    await waitFor(() => expect(continueButton).toHaveAttribute('aria-busy', 'true'));
    await expect(continueButton).toHaveAccessibleName('Continue');
  },
};

export const ContinueFailed: Story = {
  args: { error: "That didn't go through. Try again." },
  parameters: { canvasNote: "The screen's error after Continue failed; no board draws it. Continue works again." },
  play: async ({ args, canvas }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Connect Google Calendar Mock' });
    await expect(within(dialog).getByText("That didn't go through. Try again.")).toBeVisible();
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    await expect(continueButton).not.toHaveAttribute('aria-disabled');
    continueButton.click();
    await expect(args.onContinue).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'The sign-in on a phone; no board draws it. The dialog sits 16 px from the edges and scrolls inside itself.' },
  play: async ({ canvas }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const dialog = canvas.getByRole('dialog', { name: 'Connect Google Calendar Mock' });
    const box = dialog.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(16);
    await expect(box.right).toBeLessThanOrEqual(width - 16);
    const tooWide = [...dialog.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right);
    await expect(tooWide).toEqual([]);
  },
};
