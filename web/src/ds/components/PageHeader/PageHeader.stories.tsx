import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, fn, within } from 'storybook/test';

import { expectBalancedLines } from '../../test/expectBalancedLines.ts';
import { loadWebFonts } from '../../test/fonts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { PresetMenu } from '../PresetMenu/PresetMenu.tsx';
import { PageHeaderSkeleton as HeaderShapes } from './PageHeaderSkeleton.tsx';
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
    expectComputed(subtitle, { fontFamily: /Hanken Grotesk/, fontSize: '15px', color: 'rgba(250, 249, 245, 0.64)' });
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

/** Knowledge's header: a page this prototype only mocks says so once, with a Pill beside its title. */
const knowledgeHeader = {
  title: 'Knowledge',
  subtitle: 'What Claude answers from. It never changes your rules.',
  badge: <Pill>Mock</Pill>,
};

/** The vertical middle of an element's box. */
const middle = (el: Element) => {
  const box = el.getBoundingClientRect();
  return box.top + box.height / 2;
};

export const WithABadge: Story = {
  name: 'With a badge',
  args: knowledgeHeader,
  parameters: {
    canvas: 'N-Run2-Settings-Knowledge',
    canvasNote: 'Knowledge’s header: one Mock pill beside the title says the page is a mock, in place of a pill on each of its mock parts.',
  },
  play: async ({ canvas }) => {
    const title = canvas.getByRole('heading', { level: 1, name: 'Knowledge' });
    const pill = canvas.getByText('Mock');
    // Beside the title and outside it, so the heading's name stays the page's name.
    await expect(title.contains(pill)).toBe(false);
    await expect(title).toHaveAccessibleName('Knowledge');
    await expect(Math.round(pill.getBoundingClientRect().left - title.getBoundingClientRect().right)).toBe(8);
    await expect(Math.round(middle(pill))).toBe(Math.round(middle(title)));
    // The title keeps its 32 px line, and the subtitle its place 4 px under it.
    await expect(title.getBoundingClientRect().height).toBe(32);
    const subtitle = canvas.getByText(knowledgeHeader.subtitle);
    await expect(Math.round(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(4);
  },
};

export const WithABadgeOnAPhone: Story = {
  name: 'With a badge on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: knowledgeHeader,
  parameters: {
    canvas: 'N-Run2-Settings-Knowledge',
    canvasNote: 'Knowledge’s header on a phone: the Mock pill stays beside the title, and the subtitle runs under both.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const title = canvas.getByRole('heading', { level: 1, name: 'Knowledge' });
    const pill = canvas.getByText('Mock');
    await expect(Math.round(pill.getBoundingClientRect().left - title.getBoundingClientRect().right)).toBe(8);
    await expect(Math.round(middle(pill))).toBe(Math.round(middle(title)));
    const subtitle = canvas.getByText(knowledgeHeader.subtitle);
    await expect(Math.round(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** All rules' header: its subtitle, then a note on a term the page uses. */
const allRulesHeader = {
  title: 'All rules',
  subtitle: 'Every rule on this Desk, by connector and tool. To change one, ask Claude on Rules.',
  note: 'The reviewer is a separate model that reads each request before it runs. It can only hold a request for your answer, never let one through.',
};

export const WithNote: Story = {
  args: allRulesHeader,
  parameters: {
    canvas: 'none',
    canvasNote: 'All rules’ header: a quieter line under the subtitle says who “the reviewer” in its rules is. No board draws it.',
  },
  play: async ({ canvas }) => {
    const subtitle = canvas.getByText(allRulesHeader.subtitle);
    const note = canvas.getByText(allRulesHeader.note);
    // Meta type in the subtitle's secondary color, 12 px under it (the text's 4 px gap and its own 8 px).
    expectComputed(note, { fontFamily: /Hanken Grotesk/, fontSize: '14px', lineHeight: '19px', color: getComputedStyle(subtitle).color, marginTop: '8px' });
    await expect(Math.round(note.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom)).toBe(12);
    // At a reading measure: no wider than 68 of its own characters.
    await expect(note.getBoundingClientRect().width).toBeLessThanOrEqual(parseFloat(getComputedStyle(note).maxWidth) + 0.5);
    await expect(note.parentElement).toBe(subtitle.parentElement);
  },
};

export const WithNoteOnAPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: allRulesHeader,
  parameters: {
    canvas: 'none',
    canvasNote: 'All rules’ header on a phone: the note runs under the subtitle at the header’s width, as the subtitle does.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const subtitle = canvas.getByText(allRulesHeader.subtitle);
    const note = canvas.getByText(allRulesHeader.note);
    await expect(note.getBoundingClientRect().top).toBeGreaterThan(subtitle.getBoundingClientRect().bottom);
    await expect(Math.round(note.getBoundingClientRect().left)).toBe(Math.round(subtitle.getBoundingClientRect().left));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
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

const LONG_NAME = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';

/** Setup's live step with a long business name, the title composed as the live step composes it. */
const longTitle = {
  title: (
    <>
      <span data-copy="user">{LONG_NAME}</span> is live
    </>
  ),
  subtitle: 'Customers and their agents can reach your Desk at this link, day or night.',
};

/** Setup's one column: 720 px, or the window less its gutters on a phone. */
const setupColumn: NonNullable<Story['decorators']> = [
  (Story) => (
    <div style={{ width: 720, maxWidth: '100%' }}>
      <Story />
    </div>
  ),
];

/**
 * The title balances its lines: the browser evens them out rather than filling each in turn, so the
 * last word ("live", the one the whole setup builds to) doesn't sit alone, and the title keeps the
 * number of lines it would take anyway.
 */
async function expectBalancedTitle(title: HTMLElement, lines: number): Promise<void> {
  await expectBalancedLines(title, `${LONG_NAME} is live`, lines);
  await expect(title.getBoundingClientRect().height).toBe(lines * 32);
}

export const LongTitle: Story = {
  globals: { viewport: { value: 'laptop', isRotated: false } },
  args: longTitle,
  decorators: setupColumn,
  parameters: {
    canvas: 'none',
    canvasNote:
      "No reference board draws a page title this long. The nearest is the approved board UXC-P1001-After: setup's live step with a long business name, its title balanced over two lines in setup's 720 px column.",
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectBalancedTitle(canvas.getByRole('heading', { level: 1 }), 2);
  },
};

export const LongTitleOnAPhone: Story = {
  name: 'Long title on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: longTitle,
  decorators: setupColumn,
  parameters: {
    canvas: 'none',
    canvasNote:
      "No reference board draws a page title this long on a phone. The nearest is the approved board UXC-P1001-After, setup's live step at a laptop's width; on a phone the title takes three lines, balanced too.",
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    await expectBalancedTitle(canvas.getByRole('heading', { level: 1 }), 3);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
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

export const PageHeaderSkeleton: Story = {
  beforeEach: loadWebFonts,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'P12-01, UXC-P1201-After (#artboard-dec46cf506e4): page shapes follow PageHeader line boxes and responsive actions.',
  },
  render: () => (
    <div>
      {[false, true].map((below) => (
        <section key={String(below)} data-header-pair aria-label={below ? 'Actions below the title' : 'Actions beside the title'}>
          <div data-real-header>
            <PageHeader
              title="Safety"
              subtitle={RULES_LINE}
              actions={
                <div style={{ width: 140, height: 'var(--size-control)' }}>
                  <Button variant="secondary">Run a check</Button>
                </div>
              }
              actionsBelowOnPhone={below}
              hideSubtitleOnPhone={below}
            />
          </div>
          <div data-shaped-header aria-hidden="true">
            <HeaderShapes subtitleLines={{ wide: 1, phone: 2 }} actions actionsBelowOnPhone={below} hideSubtitleOnPhone={below} />
          </div>
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const pair of canvasElement.querySelectorAll('[data-header-pair]')) {
      const real = pair.querySelector<HTMLElement>('[data-real-header]')!;
      const shapes = pair.querySelector<HTMLElement>('[data-shaped-header]')!;
      for (const selector of ['.cd-page-header', '.cd-page-header__title', '.cd-page-header__subtitle', '.cd-page-header__actions']) {
        const a = real.querySelector(selector)!.getBoundingClientRect();
        const b = shapes.querySelector(selector)!.getBoundingClientRect();
        if (a.height === 0 && b.height === 0) continue;
        for (const [edge, delta] of [
          ['top', real.getBoundingClientRect().top - shapes.getBoundingClientRect().top],
          ['left', 0],
          ['height', 0],
        ] as const) {
          await expect(Math.abs(a[edge] - b[edge] - delta), `${selector} ${edge}`).toBeLessThanOrEqual(2);
        }
        if (selector === '.cd-page-header__actions') await expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(2);
      }
    }
  },
};

export const PageHeaderSkeletonPhone: Story = {
  ...PageHeaderSkeleton,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'P12-01 phone, UXC-P1201-After-Phone (#artboard-1a93c5a1f31f): subtitle lines and actions follow PageHeader phone rules.',
  },
};
