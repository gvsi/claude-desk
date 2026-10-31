import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, fn, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { PresetMenu } from '../PresetMenu/PresetMenu.tsx';
import { PageHeader, type PageHeaderProps } from './PageHeader.tsx';

const runCheck = fn();

const meta = {
  title: 'Layout/PageHeader',
  component: PageHeader,
  args: { title: 'Safety' },
  // The page's content column, as on the board.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-content)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Safety-Run1' },
} satisfies Meta<typeof PageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithAction: Story = {
  args: {
    subtitle: 'Every attempt to get around your rules, and what stopped it.',
    actions: (
      <Button variant="secondary" onClick={runCheck}>
        Run a safety check
      </Button>
    ),
  },
  parameters: {
    canvasNote: "The board's serif summary under the title is the page's own content; the header holds the title, a one-line subtitle and the action.",
  },
  play: async ({ canvas, userEvent }) => {
    // The page's one h1: serif page-title, left-aligned, in the primary text color.
    const title = canvas.getByRole('heading', { level: 1, name: 'Safety' });
    expectComputed(title, {
      fontFamily: /Source Serif 4/,
      fontSize: '24px',
      lineHeight: '32px',
      fontWeight: '460',
      textAlign: 'start',
      color: 'rgba(250, 249, 245, 0.92)',
      marginTop: '0px',
    });
    await expect(canvas.getAllByRole('heading')).toEqual([title]);
    // With no `titleRef`, the title takes no focus at all.
    await expect(title).not.toHaveAttribute('tabindex');

    const subtitle = canvas.getByText('Every attempt to get around your rules, and what stopped it.');
    expectComputed(subtitle, { fontFamily: /Hanken Grotesk/, fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(subtitle.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);

    // The action sits at the right end of the title's line.
    const action = canvas.getByRole('button', { name: 'Run a safety check' });
    const header = title.closest('header');
    if (!header) throw new Error('the title is not inside a header');
    await expect(Math.abs(header.getBoundingClientRect().right - action.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    const titleBox = title.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    await expect(Math.abs(actionBox.top + actionBox.height / 2 - (titleBox.top + titleBox.height / 2))).toBeLessThanOrEqual(1);
    await userEvent.click(action);
    await expect(runCheck).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: {
    title: 'Connectors',
    subtitle: 'What Claude can reach, and the accounts behind it.',
    actions: <Button variant="secondary">Add a connector</Button>,
  },
  parameters: {
    canvas: 'N-Conn-24-Phone-Connectors',
    canvasNote: 'The Connectors page’s header on a phone: the title with its action on one line, the subtitle under both.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const title = canvas.getByRole('heading', { level: 1, name: 'Connectors' });
    const action = canvas.getByRole('button', { name: 'Add a connector' });
    const subtitle = canvas.getByText('What Claude can reach, and the accounts behind it.');
    // The action stays on the title's line, at its right; the subtitle runs under both, 8 px under the title.
    await expect(action.getBoundingClientRect().top).toBe(title.getBoundingClientRect().top);
    await expect(action.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    await expect(Math.round(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
    await expect(subtitle.getBoundingClientRect().right).toBeGreaterThan(action.getBoundingClientRect().left);
  },
};

const RULES_LINE = 'What Claude can do on this Desk, where each tool comes from, and your rules for it.';

/** The Rules page's header, as the web app composes it: the preset menu as its action. */
const rulesHeader = {
  title: 'Rules',
  subtitle: RULES_LINE,
  actions: <PresetMenu onPick={fn()} />,
  actionsBelowOnPhone: true,
  hideSubtitleOnPhone: true,
};

export const RulesOnAPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: rulesHeader,
  parameters: {
    canvas: 'N-Conn-22-Phone-Presets',
    canvasNote: "The Rules page's header on a phone: the preset menu on its own line under the title, at the column's width, and no subtitle.",
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(390);
    const header = canvasElement.querySelector<HTMLElement>('.cd-page-header');
    if (!header) throw new Error('No header');
    const title = canvas.getByRole('heading', { level: 1, name: 'Rules' });
    const button = canvas.getByRole('button', { name: 'Start from a preset' });
    // actions_below_on_phone: the button 16 px under the title, as wide as the header.
    await expect(button.getBoundingClientRect().top - title.getBoundingClientRect().bottom).toBe(16);
    await expect(Math.round(button.getBoundingClientRect().width)).toBe(Math.round(header.getBoundingClientRect().width));
    // subtitle_hidden_on_phone
    await expect(canvas.queryByText(RULES_LINE)).not.toBeVisible();
    // The menu opens under the button at its width.
    button.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(canvasElement).getByRole('menu', { name: 'Start from a preset' });
    await expect(Math.round(menu.getBoundingClientRect().width)).toBe(Math.round(button.getBoundingClientRect().width));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const RulesOnALaptop: Story = {
  args: rulesHeader,
  parameters: {
    canvas: 'N-Conn-17-Presets',
    canvasNote: "The same header at a laptop's width: the phone props change nothing, so the menu sits at the right of the title's line and the subtitle shows.",
  },
  play: async ({ canvas }) => {
    const title = canvas.getByRole('heading', { level: 1, name: 'Rules' });
    const button = canvas.getByRole('button', { name: 'Start from a preset' });
    await expect(button.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    await expect(button.getBoundingClientRect().top).toBeLessThan(title.getBoundingClientRect().bottom);
    await expect(canvas.getByText(RULES_LINE)).toBeVisible();
  },
};

/** A page that moves focus to its title from a script, as setup's start does when "Try again" goes. */
function TitleTakesFocus(props: PageHeaderProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <PageHeader {...props} titleRef={titleRef} />
      <Button variant="secondary" onClick={() => titleRef.current?.focus({ preventScroll: true })}>
        Try again
      </Button>
    </>
  );
}

export const FocusableTitle: Story = {
  name: 'Focusable title',
  args: {
    title: 'Tell me about your business',
    subtitle: 'A few sentences is enough. You’ll see everything before anything goes live.',
  },
  render: (args) => <TitleTakesFocus {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws focus on a page’s title. Setup’s start moves focus to its title when “Try again” goes with its line (plan 04, Task 12); the nearest boards are the setup frame’s, such as N-R2-Setup-04-Answer-Failed.',
  },
  play: async ({ canvas, userEvent }) => {
    const title = canvas.getByRole('heading', { level: 1, name: 'Tell me about your business' });
    const tryAgain = canvas.getByRole('button', { name: 'Try again' });
    // Given a `titleRef`, the title takes focus from a script only: `tabIndex={-1}`.
    await expect(title).toHaveAttribute('tabindex', '-1');

    // Tab from the page passes over it to the first control.
    await userEvent.tab();
    await expect(tryAgain).toHaveFocus();

    // A script moves focus to it.
    await userEvent.click(tryAgain);
    await expect(title).toHaveFocus();

    // Tab goes on from it to the next control, and Shift+Tab back never stops on it.
    await userEvent.tab();
    await expect(tryAgain).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(title).not.toHaveFocus();
  },
};
