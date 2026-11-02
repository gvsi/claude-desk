import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { RecordedTag } from './RecordedTag.tsx';

/** Caption type in secondary ink, the tag's one look wherever it sits. */
const CAPTION_SECONDARY = { fontSize: '13px', lineHeight: '18px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.64)' };

/** The tag's icon: Lucide's history at 14 px, hidden from screen readers. */
async function expectHistoryIcon(tag: HTMLElement) {
  const icon = tag.querySelector('svg');
  if (!icon) throw new Error('no icon in the tag');
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  await expect(icon).toHaveAttribute('width', '14');
  await expect(icon.querySelectorAll('path')).toHaveLength(3);
}

const meta = {
  title: 'Recorded history/RecordedTag',
  component: RecordedTag,
  // Drawn on every recorded-history board: on a conversation's status line, after where an
  // attempt came from, and on a lead.
  parameters: { layout: 'padded', canvas: 'N-History-Conversations' },
} satisfies Meta<typeof RecordedTag>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // The word says it; the icon beside it is decoration.
    const tag = canvas.getByText('Recorded');
    await expect(tag).toHaveTextContent(/^Recorded$/);
    await expectHistoryIcon(tag);

    // An inline row, 4 px between the icon and the word, on one line in caption type.
    expectComputed(tag, { display: 'inline-flex', alignItems: 'center', columnGap: '4px', whiteSpace: 'nowrap', ...CAPTION_SECONDARY });
    const icon = tag.querySelector('svg') as SVGSVGElement;
    const word = tag.getBoundingClientRect();
    await expect(Math.round(icon.getBoundingClientRect().left)).toBe(Math.round(word.left));
    await expect(icon.getBoundingClientRect().height).toBe(14);
  },
};

/**
 * People has no row component: the web app composes each lead and puts the tag at the end of the
 * lead's second line, under the time, as the People board draws it.
 */
export const OnALead: Story = {
  render: () => (
    <ul aria-label="Leads" style={{ width: 760, maxWidth: '100%', margin: 0, padding: 0, listStyle: 'none' }}>
      <li
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 'var(--space-16)',
          rowGap: 'var(--space-2)',
          padding: 'var(--space-6) var(--space-10)',
        }}
      >
        <span className="cd-type-control" data-copy="user">
          Jordan Pike
        </span>
        <span className="cd-type-caption" style={{ color: 'var(--text-secondary)', justifySelf: 'end' }}>
          Yesterday, 8:05 pm
        </span>
        <span className="cd-type-caption" style={{ minWidth: 0, color: 'var(--text-secondary)' }}>
          Asked about a gas line for an outdoor grill. Not on your price list.
        </span>
        <RecordedTag className="story-lead-tag" />
      </li>
    </ul>
  ),
  parameters: { canvas: 'N-History-People', canvasNote: 'One replayed lead, as People composes it; the board lists three under their section.' },
  play: async ({ canvas }) => {
    const lead = within(canvas.getByRole('list', { name: 'Leads' })).getByRole('listitem');
    const tag = within(lead).getByText('Recorded');
    await expectHistoryIcon(tag);
    // The consumer's class rides along with the tag's own.
    await expect(tag).toHaveClass('cd-recorded-tag', 'story-lead-tag');
    // At the end of the second line: under the time, its right edge on the time's.
    const time = within(lead).getByText('Yesterday, 8:05 pm');
    await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
    await expect(tag.getBoundingClientRect().top).toBeGreaterThanOrEqual(time.getBoundingClientRect().bottom);
  },
};
