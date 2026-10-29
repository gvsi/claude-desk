import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Greeting } from './Greeting.tsx';

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
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
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

    // The public link, and a button that copies it.
    await expect(canvas.getByText(PUBLIC_LINK)).toBeVisible();
    const copy = canvas.getByRole('button', { name: 'Copy your Desk link' });
    await userEvent.click(copy);
    await expect(args.link?.onCopy).toHaveBeenCalledTimes(1);

    // The link sits at the right of the greeting's line.
    await expect(copy.getBoundingClientRect().left).toBeGreaterThan(heading.getBoundingClientRect().right);
  },
};
