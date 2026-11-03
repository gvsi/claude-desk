import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';

/** Claude's reply on N-MD-01: a paragraph, a heading, bold, both kinds of list, a table and a link. */
const REPLY = [
  'Lukewarm showers from a tank that age are common, and both choices can be sensible.',
  '### Repair or replace',
  '**Repair** usually makes sense when:',
  "- the tank isn't leaking\n- it's one worn part, like the thermostat or a heating element",
  '**Replace** is usually better when:',
  "1. there's rust in the hot water, or water around the base\n2. the tank is past about 12 years, like yours",
  '| | Repair | Replace |\n| --- | --- | --- |\n| What changes | One worn part | The whole tank |\n| Best when | No leaks, newer tank | Rust, leaks or 12+ years |',
  'The age is on the label on the side of the tank, and the [Energy Saver guide to water heaters](https://www.energy.gov/energysaver/water-heating) explains the options. Would you like Mike to take a look?',
].join('\n\n');

/** Ask Claude's answer on N-MD-05, as the stream has it so far. */
const STREAMING = [
  "Yes. I'd set it up like this:",
  '1. **When:** right after an install is booked\n2. **How much:** the amount on your price list, so nothing is invented\n3. **Who decides:** the Desk sends the payment link on its own up to ',
].join('\n\n');

/** The reading column the visitor's chat draws replies in. */
const inReadingColumn: Decorator = (Story) => (
  <div style={{ width: 'var(--size-reading)', maxWidth: '100%' }}>
    <Story />
  </div>
);

/** The text a reader sees, without the line breaks between a list's or a table's parts. */
function words(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const meta = {
  title: 'Conversation/ChatMarkdown',
  component: ChatMarkdown,
  // Links open, as the board draws them and ClaudeMessage's Link story shows them.
  args: { text: REPLY, links: 'open' },
  decorators: [inReadingColumn],
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote:
      'N-MD-01-Reply-Markdown (signed 2026-11-01, not yet a reference board) draws this reply in the visitor chat; this is the reply alone in the reading column. Nearest reference board: N-Public-Rivera-Run1.',
  },
} satisfies Meta<typeof ChatMarkdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Reply: Story = {
  play: async ({ canvas, canvasElement }) => {
    const md = canvasElement.querySelector('.cd-md') as HTMLElement;
    await expect([...md.children].map((child) => child.tagName.toLowerCase())).toEqual(['p', 'h3', 'p', 'ul', 'p', 'ol', 'div', 'p']);
    // The reply type, as Claude's other words: serif 15/23 at weight 360.
    expectComputed(md.querySelector('p') as Element, { fontFamily: /Source Serif 4/, fontSize: '17px', lineHeight: '26px', fontWeight: '380' });
    // A heading stays at the reply's size, so a chat reply never gets a page-size title.
    expectComputed(md.querySelector('h3') as Element, { fontFamily: /Source Serif 4/, fontSize: '17px', lineHeight: '26px', fontWeight: '600', marginTop: '16px' });
    expectComputed(md.querySelector('strong') as Element, { fontWeight: '600' });
    expectComputed(md.querySelector('ul') as Element, { paddingLeft: '22px', marginTop: '4px' });
    expectComputed(md.querySelector('li + li') as Element, { marginTop: '4px' });
    // The table sits in a hairline card; its header row on the muted ground.
    expectComputed(md.querySelector('.cd-md__table') as Element, { borderTopWidth: '1px', borderTopLeftRadius: '12px', overflowX: 'auto', marginTop: '10px' });
    for (const cell of md.querySelectorAll('thead tr > *')) {
      expectComputed(cell, { fontWeight: '600', fontSize: '16px', lineHeight: '23px', backgroundColor: 'rgb(46, 44, 38)' });
    }
    expectComputed(md.querySelector('tbody td') as Element, { fontWeight: '380', paddingTop: '8px', paddingLeft: '12px' });
    // The link shows its text only, in the accent, and opens in a new tab.
    const link = canvas.getByRole('link', { name: 'Energy Saver guide to water heaters' });
    expectComputed(link, { color: 'rgb(126, 174, 218)', textDecorationLine: 'underline' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(words(md)).not.toMatch(/[*|#[\]]/);
  },
};

export const MidStream: Story = {
  args: { text: STREAMING, streaming: true },
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-side-panel)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvasNote:
      "N-MD-05-Ask-Claude-Streaming (signed 2026-11-01, not yet a reference board) draws this answer streaming into the Ask Claude panel; this is the answer alone at the panel's width. Nearest reference board: N-Conn-12-Chat.",
  },
  play: async ({ canvasElement }) => {
    const md = canvasElement.querySelector('.cd-md') as HTMLElement;
    // Bold closes while the text is still arriving, and the list grows item by item.
    await expect([...md.querySelectorAll('li strong')].map((label) => label.textContent)).toEqual(['When:', 'How much:', 'Who decides:']);
    await expect(words(md)).toMatch(/on its own up to$/);
    await expect(words(md)).not.toContain('**');
  },
};

export const Reveal: Story = {
  args: { reveal: true, onRevealed: fn() },
  parameters: {
    canvasNote:
      'N-MD-02-Visitor-Revealing and N-MD-06-Visitor-Reveal-Motion (signed 2026-11-01, not yet reference boards) draw this reply revealing word by word; this is the reply alone in the reading column. Nearest reference board: N-Public-Rivera-Run1.',
  },
  play: async ({ args, canvasElement }) => {
    const md = canvasElement.querySelector('.cd-md') as HTMLElement;
    const whole = 'Lukewarm showers from a tank that age are common, and both choices can be sensible.';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Under reduced motion the reply shows whole, at once.
      await expect(md.querySelector('p')?.textContent).toBe(whole);
      await expect(args.onRevealed).toHaveBeenCalledTimes(1);
      return;
    }
    // It starts with the first words and grows, a word at a time, to the whole reply in about 3 s.
    await expect(md.querySelector('a')).toBeNull();
    await waitFor(() => expect(args.onRevealed).toHaveBeenCalledTimes(1), { timeout: 4500 });
    await expect(md.querySelector('p')?.textContent).toBe(whole);
    await expect(md.querySelector('a')?.textContent).toBe('Energy Saver guide to water heaters');
  },
};
