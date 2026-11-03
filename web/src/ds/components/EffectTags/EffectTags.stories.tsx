import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { Effect } from '../../../api/contracts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { EffectTags } from './EffectTags.tsx';

/** Turner Plumbing's tools as C4 and B2 tag them, each after its title. */
const TOOLS: readonly { title: string; effects: readonly Effect[]; reversible: boolean; tags: readonly string[] }[] = [
  { title: 'Payment link', effects: ['charge'], reversible: false, tags: ['Money', "Can't be undone"] },
  { title: 'Share a document', effects: ['private_data', 'send_message'], reversible: false, tags: ['Private data', "Can't be undone"] },
  { title: 'See charges', effects: ['private_data'], reversible: true, tags: ['Private data'] },
  { title: 'Refund', effects: ['pay_out', 'private_data'], reversible: false, tags: ['Money', "Can't be undone"] },
  { title: 'Quote', effects: ['change'], reversible: true, tags: [] },
];

const meta = {
  title: 'Rules/EffectTags',
  component: EffectTags,
  args: { effects: ['charge'], reversible: false },
  render: () => (
    <ul role="list" style={{ maxWidth: 738, margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
      {TOOLS.map((tool) => (
        <li key={tool.title}>
          <p className="cd-type-body" style={{ margin: 0, color: 'var(--text-primary)' }}>
            <span className="cd-user-name" data-copy="user">
              {tool.title}
            </span>
            <EffectTags effects={tool.effects} reversible={tool.reversible} />
          </p>
        </li>
      ))}
    </ul>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote:
      'The tool tags from the REV-RULES-C4 board (Your tools), in review on the In review page, with the words "Can\'t be undone" from the signed N-Conn-19; no signed board draws the tags yet. The nearest signed board is N-Conn-02-Payments.',
  },
} satisfies Meta<typeof EffectTags>;

export default meta;

type Story = StoryObj<typeof meta>;

async function expectTags(canvasElement: HTMLElement) {
  const lines = [...canvasElement.querySelectorAll<HTMLElement>('li')];
  await expect(lines.map((line) => [...line.querySelectorAll('.cd-pill')].map((pill) => pill.textContent))).toEqual(TOOLS.map((tool) => tool.tags));
  // 8 px after the title, 4 px between the pills.
  const first = lines[0];
  const title = first?.querySelector<HTMLElement>('.cd-user-name');
  const pills = [...(first?.querySelectorAll<HTMLElement>('.cd-pill') ?? [])];
  const [money, undo] = pills;
  if (!title || !money || !undo) throw new Error('no tags');
  await expect(Math.round(money.getBoundingClientRect().left - title.getBoundingClientRect().right)).toBe(8);
  await expect(Math.round(undo.getBoundingClientRect().left - money.getBoundingClientRect().right)).toBe(4);
  expectComputed(money, { height: '20px' });
}

export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBe(1440);
    await expectTags(canvasElement);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    await expectTags(canvasElement);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
};
