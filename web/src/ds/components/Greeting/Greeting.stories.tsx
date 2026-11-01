import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { pairContrast } from '../../contrast.ts';
import { faintestOpacity, paintedGroundOf } from '../../test/breath.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { lineWords } from '../../test/lineWords.ts';
import { Button } from '../Button/Button.tsx';
import { Greeting, type GreetingProps } from './Greeting.tsx';

/** The public link as the owner's screen would show it: a display string, never fetched. */
const PUBLIC_LINK = `desk.example/d/${rivera.business.slug}`;

const meta = {
  title: 'Layout/Greeting',
  component: Greeting,
  args: { text: 'Good morning, Maria' },
  // Today's content column, as on the board.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-content)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof Greeting>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithPresence: Story = {
  args: {
    presence: {
      line: 'Two people and one agent are talking to your Desk right now.',
      people: [{ kind: 'person', initials: 'DW' }, { kind: 'person' }, { kind: 'agent' }],
    },
    link: { label: PUBLIC_LINK, onCopy: fn() },
  },
  parameters: {
    canvasNote:
      "The board's link pill has a green dot with no words to say what it means, so the pill leaves it out; a person with initials on record shows them in place of the person glyph.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The greeting is Today's title, in Claude's serif voice.
    const heading = canvas.getByRole('heading', { level: 1, name: 'Good morning, Maria' });
    expectComputed(heading, { fontFamily: /Source Serif 4/, fontSize: '36px', lineHeight: '44px', fontWeight: '300', marginTop: '0px' });

    // The presence line says it in words; the glyphs beside it are decoration, hidden from readers.
    const line = canvas.getByText('Two people and one agent are talking to your Desk right now.');
    expectComputed(line, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    const glyphs = [...canvasElement.querySelectorAll<HTMLElement>('.cd-greeting__glyph')];
    await expect(glyphs).toHaveLength(3);
    const hidden = glyphs[0]?.closest('[aria-hidden="true"]');
    await expect(hidden).not.toBeNull();
    for (const glyph of glyphs) await expect(hidden?.contains(glyph)).toBe(true);
    await expect(glyphs[0]).toHaveTextContent('DW');
    await expect(glyphs[1]?.querySelector('svg')).not.toBeNull();
    await expect(glyphs[2]?.querySelector('svg')).not.toBeNull();

    // They breathe slowly over motion-breathe, out of step with each other.
    for (const glyph of glyphs) {
      expectComputed(glyph, { animationName: /^(?!none$).+/, animationDuration: '5s', animationIterationCount: 'infinite' });
    }
    await expect(getComputedStyle(glyphs[1] as HTMLElement).animationDelay).not.toBe(getComputedStyle(glyphs[0] as HTMLElement).animationDelay);
    // presence_glyphs_keep_their_contrast: at the breath's faintest point each glyph, faded as one
    // over the page, still reads against its own circle: its initials as text (4.5:1), its icon as
    // a mark (3:1).
    for (const glyph of glyphs) {
      const faintest = faintestOpacity(glyph);
      await expect(faintest).toBeLessThan(1);
      const style = getComputedStyle(glyph);
      const ratio = pairContrast({ fg: style.color, ground: style.backgroundColor, over: paintedGroundOf(glyph), opacity: faintest });
      await expect(ratio).toBeGreaterThanOrEqual(glyph.querySelector('svg') === null ? 4.5 : 3);
    }

    // The public link, and a button that copies it.
    await expect(canvas.getByText(PUBLIC_LINK)).toBeVisible();
    const copy = canvas.getByRole('button', { name: 'Copy your Desk link' });
    await userEvent.click(copy);
    await expect(args.link?.onCopy).toHaveBeenCalledTimes(1);

    // The link sits at the right of the greeting's line.
    await expect(copy.getBoundingClientRect().left).toBeGreaterThan(heading.getBoundingClientRect().right);
  },
};

/** The greeting with the screen's own action after the link pill, as Today has "Chat as a customer". */
export const WithActions: Story = {
  args: {
    presence: { line: 'One person is talking to your Desk right now.', people: [{ kind: 'person' }] },
    link: { label: PUBLIC_LINK, onCopy: fn() },
    actions: (
      <Button variant="secondary" href={`https://${PUBLIC_LINK}`} external>
        Chat as a customer
      </Button>
    ),
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'TOD-04 (signed 2026-11-01) draws the top of Today with the link pill and "Chat as a customer" at the right of the greeting\'s line, their tops level with the greeting\'s; no reference board draws it, and the nearest is N-Today-Run1.',
  },
  play: async ({ canvas, canvasElement }) => {
    const header = canvasElement.querySelector<HTMLElement>('.cd-greeting');
    const pill = canvasElement.querySelector<HTMLElement>('.cd-greeting__link');
    if (!header || !pill) throw new Error('the greeting draws its header and link pill');
    const heading = canvas.getByRole('heading', { level: 1, name: 'Good morning, Maria' }).getBoundingClientRect();
    const action = canvas.getByRole('link', { name: 'Chat as a customer' }).getBoundingClientRect();
    const link = pill.getBoundingClientRect();

    // The pill, then the action, at the right of the greeting's line, 12 px apart.
    await expect(link.left).toBeGreaterThan(heading.right);
    await expect(action.left - link.right).toBeCloseTo(12, 0);
    await expect(Math.abs(action.right - header.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
    // Their tops sit 4 px under the greeting's, level with its first line.
    await expect(link.top - heading.top).toBeCloseTo(4, 0);
    await expect(action.top - heading.top).toBeCloseTo(4, 0);
    expectComputed(pill, { marginTop: '0px' });
  },
};

export const WithActionsOnAPhone: Story = {
  name: 'With actions on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: WithActions.args,
  parameters: {
    canvas: 'none',
    canvasNote: "TOD-04's phone board (signed 2026-11-01): the greeting, its presence line, then the link pill and the action, 16 px apart.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    const heading = canvas.getByRole('heading', { level: 1, name: 'Good morning, Maria' }).getBoundingClientRect();
    const presence = canvas.getByText('One person is talking to your Desk right now.').closest('p')!.getBoundingClientRect();
    const link = canvasElement.querySelector<HTMLElement>('.cd-greeting__link')!.getBoundingClientRect();
    const action = canvas.getByRole('link', { name: 'Chat as a customer' }).getBoundingClientRect();
    // In that order down the page, from the same left edge, the pill 16 px under the presence line.
    await expect(presence.top).toBeGreaterThanOrEqual(heading.bottom);
    await expect(link.top - presence.bottom).toBeCloseTo(16, 0);
    await expect(action.top).toBeGreaterThan(link.top);
    for (const box of [presence, link, action]) await expect(box.left).toBeCloseTo(heading.left, 0);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** The check icon's shape, as the icon set draws it. */
const CHECK_PATH = 'M20 6 9 17l-5-5';

export const Copied: Story = {
  args: {
    presence: { line: 'One person is talking to your Desk right now.', people: [{ kind: 'person' }] },
    link: { label: PUBLIC_LINK, onCopy: fn(), copied: true },
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'UXC-P203-After (canvas page "UX craft proposals", signed 2026-10-30) draws the link pill just after a copy; no reference board draws it, and the nearest is N-Today-Run1.',
  },
  play: async ({ canvas, canvasElement }) => {
    const pill = canvasElement.querySelector<HTMLElement>('.cd-greeting__link');
    if (!pill) throw new Error('the greeting draws its link pill');

    // The link's words give way to "Copied", in text-primary.
    const copied = within(pill).getByText('Copied', { exact: true });
    expectComputed(copied, { opacity: '1', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(within(pill).getByText(PUBLIC_LINK), { opacity: '0' });

    // The copy icon gives way to a check.
    const check = pill.querySelector<SVGElement>(`svg:has(path[d="${CHECK_PATH}"])`);
    const copyIcon = canvas.getByRole('button', { name: 'Copy your Desk link' }).querySelector('svg');
    if (!check || !copyIcon) throw new Error('the pill draws the check, and the button its copy icon');
    await expect(check.getBoundingClientRect().width).toBe(16);
    expectComputed(check.parentElement ?? check, { opacity: '1' });
    expectComputed(copyIcon, { opacity: '0' });

    // The button keeps its name. "Copied" and the check are for the eye: the screen's own status
    // line says it to screen readers.
    await expect(canvas.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Copy your Desk link']);
    await expect(copied).toHaveAttribute('aria-hidden', 'true');
    await expect(check.parentElement).toHaveAttribute('aria-hidden', 'true');
  },
};

/** The greeting wired as Today wires it: a press that copies sets `copied`. */
function CopiesOnPress(args: GreetingProps) {
  const [copied, setCopied] = useState(false);
  const { link } = args;
  if (!link) return <Greeting {...args} />;
  const onCopy = () => {
    link.onCopy();
    setCopied(true);
  };
  return <Greeting {...args} link={{ ...link, copied, onCopy }} />;
}

export const CopiedAfterPress: Story = {
  args: {
    presence: { line: 'One person is talking to your Desk right now.', people: [{ kind: 'person' }] },
    link: { label: PUBLIC_LINK, onCopy: fn() },
  },
  render: (args) => <CopiesOnPress {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote:
      'UXC-P203-After (canvas page "UX craft proposals", signed 2026-10-30) draws the press and the crossfade to "Copied"; no reference board draws it, and the nearest is N-Today-Run1. Clearing it is the screen\'s.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const pill = canvasElement.querySelector<HTMLElement>('.cd-greeting__link');
    if (!pill) throw new Error('the greeting draws its link pill');
    const words = within(pill).getByText(PUBLIC_LINK);
    const before = { pill: pill.getBoundingClientRect(), words: words.getBoundingClientRect() };

    // Before a copy, a pointer on the link's words reaches them, not the faded "Copied" over them,
    // so the owner can select the link by hand (as a failed copy asks), and "Copied" never joins
    // a selection.
    const start = document.elementFromPoint(before.words.left + 4, before.words.top + before.words.height / 2);
    await expect(start).toBe(words);
    expectComputed(within(pill).getByText('Copied', { exact: true }), { userSelect: 'none' });

    await userEvent.click(canvas.getByRole('button', { name: 'Copy your Desk link' }));
    await expect(args.link?.onCopy).toHaveBeenCalledTimes(1);

    // The link's words cross to "Copied" over motion-fast.
    const copied = within(pill).getByText('Copied', { exact: true });
    for (const layer of [words, copied]) expectComputed(layer, { transitionProperty: 'opacity', transitionDuration: '0.12s' });
    await waitFor(() => expectComputed(copied, { opacity: '1' }));
    await waitFor(() => expectComputed(words, { opacity: '0' }));

    // The pill keeps its width, measured: "Copied" is laid over the link's words, where they start.
    const after = pill.getBoundingClientRect();
    await expect({ left: after.left, width: after.width, height: after.height }).toEqual({
      left: before.pill.left,
      width: before.pill.width,
      height: before.pill.height,
    });
    await expect(copied.getBoundingClientRect().left).toBe(before.words.left);
    await expect(words.getBoundingClientRect().width).toBe(before.words.width);
  },
};

export const LongGreetingOnAPhone: Story = {
  name: 'Long greeting on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: { text: 'Good morning, Maximiliana', link: { label: PUBLIC_LINK, onCopy: fn() } },
  parameters: {
    canvas: 'none',
    canvasNote:
      "No reference board draws Today's greeting on a phone with a long name. The nearest is N-Today-Run1, at the canvas's width; on a phone a long name takes the greeting's second line, and the link drops under it.",
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    // The greeting balances its lines, as page titles do: the name whole on the second, nothing cut.
    const heading = canvas.getByRole('heading', { level: 1, name: 'Good morning, Maximiliana' });
    expectComputed(heading, { textWrapStyle: 'balance' });
    await expect(lineWords(heading)).toEqual([['Good', 'morning,'], ['Maximiliana']]);
    await expect(heading.getBoundingClientRect().height).toBe(2 * 44);
    await expect(canvas.getByRole('button', { name: 'Copy your Desk link' }).getBoundingClientRect().top).toBeGreaterThan(heading.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
