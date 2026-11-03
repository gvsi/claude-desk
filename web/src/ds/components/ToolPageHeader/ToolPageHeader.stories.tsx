import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectBalancedLines } from '../../test/expectBalancedLines.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ToolPageHeader, type ToolPageHeaderProps } from './ToolPageHeader.tsx';

const { refund, quote } = rivera.toolPages;

const meta = {
  title: 'Connectors/ToolPageHeader',
  component: ToolPageHeader,
  args: { ...refund, status: 'enabled' },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ToolPageHeader {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-05-Refund' },
} satisfies Meta<typeof ToolPageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The demo's simulate strip, or null when the header has none. */
function simulateStrip(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.cd-tool-page-header__simulate');
}

/** simulate_only_when_on: no strip, and no "Simulate a tool change" anywhere. */
async function expectNoSimulate(root: HTMLElement) {
  await expect(simulateStrip(root)).toBeNull();
  await expect(within(root).queryByRole('button', { name: 'Simulate a tool change' })).toBeNull();
  await expect(root).not.toHaveTextContent('Demo only');
}

/** The source line's status: its words and the tone of the dot beside them. */
async function expectStatus(root: HTMLElement, words: string, tone: 'handled' | 'info') {
  const status = root.querySelector('.cd-tool-page-header__status');
  if (!(status instanceof HTMLElement)) throw new Error('No status');
  await expect(status).toHaveTextContent(words);
  await expect(status.textContent).toBe(words);
  const dot = status.querySelector(`.cd-status-dot--${tone}`);
  await expect(dot).not.toBeNull();
  await expect(dot).toHaveAttribute('aria-hidden', 'true');
}

export const Refund: Story = {
  play: async ({ args, canvas, canvasElement }) => {
    // The tool's name is the page's serif h1, its description under it.
    const title = canvas.getByRole('heading', { level: 1, name: 'Refund' });
    expectComputed(title, { fontSize: '26px', fontFamily: '"Source Serif 4", Georgia, serif' });
    const description = canvas.getByText(args.description);
    expectComputed(description, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.64)' });
    // The source line: Stripe's mark, 20 px with no tile, "From Stripe" with its Mock badge, and the status.
    const source = canvasElement.querySelector('.cd-tool-page-header__source');
    if (!(source instanceof HTMLElement)) throw new Error('No source line');
    await expect(source).toHaveTextContent('From Stripe Mock');
    expectComputed(source.querySelector('.cd-connector-icon') as Element, { width: '20px', height: '20px' });
    expectComputed(source.querySelector('.cd-connector-icon svg') as Element, { width: '20px', height: '20px' });
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectStatus(canvasElement, 'On · Definition unchanged', 'handled');
    expectComputed(source, { fontSize: '14px' });
    await expect(source.getBoundingClientRect().top).toBeGreaterThanOrEqual(description.getBoundingClientRect().bottom);
    // simulate_only_when_on: without onSimulateChange there is no strip.
    await expectNoSimulate(canvasElement);
  },
};

export const Quote: Story = {
  args: { ...quote, definitionNote: undefined, status: 'enabled', onSimulateChange: fn() },
  parameters: {
    canvas: 'N-Conn-06-Quote',
    canvasNote: 'A built-in tool has no pinned definition, so it gets no definition note, where the board shows "Definition unchanged".',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Quote' })).toBeVisible();
    const source = canvasElement.querySelector('.cd-tool-page-header__source');
    if (!(source instanceof HTMLElement)) throw new Error('No source line');
    await expect(within(source).getByText('Built in')).toBeVisible();
    await expect(source).toHaveTextContent('From Quotes Built in');
    // A built-in connector keeps its 24 px tile, its line icon 13 px on it.
    expectComputed(source.querySelector('.cd-connector-icon') as Element, { width: '24px', height: '24px' });
    expectComputed(source.querySelector('.cd-connector-icon svg') as Element, { width: '13px', height: '13px' });
    await expectStatus(canvasElement, 'On', 'handled');
    // simulate_only_when_on: a built-in tool has no mock server to change, even with the callback.
    await expectNoSimulate(canvasElement);
  },
};

export const RefundNeedsReview: Story = {
  args: { ...refund, definitionNote: undefined, status: 'needs_review', onSimulateChange: fn() },
  parameters: { canvas: 'N-Conn-14-Changed-Review' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'Off until you review a change', 'info');
    // simulate_only_when_on: a tool already waiting for a review has no strip, even with the callback.
    await expectNoSimulate(canvasElement);
  },
};

export const RefundReviewed: Story = {
  args: { ...refund, definitionNote: 'Definition reviewed today', status: 'enabled' },
  parameters: { canvas: 'N-Conn-15-Changed-After' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'On · Definition reviewed today', 'handled');
  },
};

export const Off: Story = {
  args: { ...refund, definitionNote: 'Definition unchanged', status: 'disabled', onSimulateChange: fn() },
  parameters: { canvasNote: 'A tool the owner kept off; no board draws it. The definition note shows only while the tool is on.' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'Off', 'info');
    // simulate_only_when_on: a tool that is off has no strip, even with the callback.
    await expectNoSimulate(canvasElement);
  },
};

const SIMULATE_CAPTION = "Demo only. Changes this tool's definition on the mock Stripe server, so you can see what happens.";

export const WithSimulate: Story = {
  args: { ...refund, status: 'enabled', onSimulateChange: fn() },
  parameters: { canvas: 'N-Conn-21-Simulate' },
  play: async ({ args, canvas, canvasElement }) => {
    // simulate_only_when_on: a connected tool that is on gets the demo's strip under its source line.
    const strip = simulateStrip(canvasElement);
    if (strip === null) throw new Error('No simulate strip');
    const source = canvasElement.querySelector('.cd-tool-page-header__source');
    if (!(source instanceof HTMLElement)) throw new Error('No source line');
    await expect(strip.getBoundingClientRect().top - source.getBoundingClientRect().bottom).toBe(20);
    // A bordered row with no fill: the caption at the left, the ghost button at the right.
    expectComputed(strip, {
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      paddingTop: '10px',
      paddingLeft: '14px',
    });
    const caption = within(strip).getByText(SIMULATE_CAPTION);
    expectComputed(caption, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    const button = canvas.getByRole('button', { name: 'Simulate a tool change' });
    await expect(button).toHaveClass('cd-button--ghost');
    await expect(strip.getBoundingClientRect().right - button.getBoundingClientRect().right).toBe(15);
    await expect(Math.abs(caption.getBoundingClientRect().left - strip.getBoundingClientRect().left)).toBe(15);
    // simulate_calls_once: two presses send one change, with nothing in it, and the button waits.
    await button.click();
    await button.click();
    await expect(args.onSimulateChange).toHaveBeenCalledTimes(1);
    await expect(args.onSimulateChange).toHaveBeenCalledWith();
    await expect(button).toHaveAttribute('aria-busy', 'true');
  },
};

/** A tool page that sets `simulatePending` as soon as the change is sent, and keeps it while it runs. */
function SimulatesSlowly(props: ToolPageHeaderProps) {
  const [pending, setPending] = useState(false);
  return (
    <ToolPageHeader
      {...props}
      simulatePending={pending}
      onSimulateChange={() => {
        void props.onSimulateChange?.();
        setPending(true);
      }}
    />
  );
}

export const Simulating: Story = {
  args: { ...refund, status: 'enabled', onSimulateChange: fn() },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <SimulatesSlowly {...args} />
    </div>
  ),
  parameters: { canvas: 'N-Conn-21-Simulate', canvasNote: 'The simulated change in flight; the board draws the button at rest.' },
  play: async ({ args, canvas, userEvent }) => {
    // simulate_busy_keeps_its_width: pressed, the button keeps its name and width, its spinner in
    // place of the label, until the screen's pending clears.
    const button = canvas.getByRole('button', { name: 'Simulate a tool change' });
    const width = button.getBoundingClientRect().width;
    await userEvent.click(button);
    await expect(args.onSimulateChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    await expect(canvas.getByRole('button', { name: 'Simulate a tool change' })).toBe(button);
    await expect(button.getBoundingClientRect().width).toBe(width);
    await expect(button.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    await expect(button).toHaveTextContent('Simulate a tool change');
    await userEvent.click(button);
    await expect(args.onSimulateChange).toHaveBeenCalledTimes(1);
  },
};

/**
 * A tool with a long name, as a connected app might name one. Wrapped greedily on a phone, it would
 * leave "visit" alone on its last line.
 */
const LONG_NAME = 'Refund a deposit to the card it came from when a customer cancels a visit';

export const LongName: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { name: LONG_NAME },
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board draws a tool name this long; the demo's are a word or two. The nearest is N-Conn-05-Refund. On a laptop the name fits the page's line, so it stays on one.",
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(1440);
    await expectBalancedLines(canvas.getByRole('heading', { level: 1 }), LONG_NAME, 1);
  },
};

export const LongNameOnAPhone: Story = {
  name: 'Long name on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: { name: LONG_NAME },
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board draws a tool name this long, or a tool's page on a phone. The nearest is N-Conn-05-Refund, at the canvas's width; on a phone the name takes three lines, balanced so its last word doesn't sit alone.",
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    await expectBalancedLines(canvas.getByRole('heading', { level: 1 }), LONG_NAME);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
