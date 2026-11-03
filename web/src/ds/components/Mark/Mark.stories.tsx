import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Mark as DeskMark, MarkAppIcon, Wordmark } from './Mark.tsx';
import { MARK_GEOMETRY } from './markGeometry.ts';

const meta = {
  title: 'Layout/Mark',
  component: DeskMark,
  args: { size: 20 },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof DeskMark>;

export default meta;

type Story = StoryObj<typeof meta>;

const SIZES = [16, 20, 24, 32, 36] as const;

const DARK_INK = 'rgb(20, 20, 19)';
const LIGHT_INK = 'rgb(250, 249, 245)';

/**
 * Checks one drawn mark: decorative, on the drawing's grid, with or without its tile, and the bell
 * inside it exactly as the drawing has it (the clay dome, then the ink over it) in `ink`.
 */
async function expectMark(mark: SVGSVGElement, { tile, ink }: { tile: boolean; ink: string }) {
  await expect(mark).toHaveAttribute('aria-hidden', 'true');
  await expect(mark).toHaveAttribute('focusable', 'false');
  await expect(mark).toHaveAttribute('viewBox', '0 0 100 100');
  const art = mark.querySelector(':scope > g');
  await expect([...mark.children].map((child) => child.tagName)).toEqual(tile ? ['rect', 'g'] : ['g']);
  const groups = [...(art?.children ?? [])].map((group) => group.getAttribute('class'));
  await expect(groups).toEqual(['cd-mark__clay', 'cd-mark__ink']);
  const clay = art?.querySelector(':scope > .cd-mark__clay');
  const inkGroup = art?.querySelector(':scope > .cd-mark__ink');
  await expect(art).toHaveAttribute('transform', MARK_GEOMETRY.art);
  expectComputed(clay as Element, { fill: 'rgb(217, 119, 87)' });
  expectComputed(inkGroup as Element, { fill: ink });
  // The one clay blob, and the six ink strokes with a round dot at both ends of each, exactly as
  // the drawing has them and in its order.
  const number = (shape: Element, name: string) => Number(shape.getAttribute(name));
  await expect([...(clay?.children ?? [])].map((shape) => shape.getAttribute('d'))).toEqual([...MARK_GEOMETRY.clay]);
  const drawn = [...(inkGroup?.children ?? [])].map((shape) =>
    shape.tagName === 'path' ? { d: shape.getAttribute('d') } : { cx: number(shape, 'cx'), cy: number(shape, 'cy'), r: number(shape, 'r') },
  );
  await expect(drawn).toEqual(MARK_GEOMETRY.ink);
  await expect(inkGroup?.querySelectorAll(':scope > path')).toHaveLength(6);
  await expect(inkGroup?.querySelectorAll(':scope > circle')).toHaveLength(12);
  if (tile) {
    // The white tile with its hairline edge, behind the bell.
    const rect = mark.querySelector(':scope > rect.cd-mark__tile') as Element;
    expectComputed(rect, { fill: 'rgb(255, 255, 255)', stroke: 'rgba(20, 20, 19, 0.1)' });
    await expect(Object.fromEntries(Object.keys(MARK_GEOMETRY.tile).map((name) => [name, number(rect, name)]))).toEqual(
      MARK_GEOMETRY.tile,
    );
  }
}

export const Mark: Story = {
  parameters: {
    canvasNote:
      'N-Today-Run1 draws the earlier counter mark. The bell (N-Explore-Mark-Bell) replaced it, drawn without its tile in its light ink on the dark grounds (N-Explore-Mark-Decided, signed 2026-10-30).',
  },
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-16)' }}>
      {SIZES.map((size) => (
        <DeskMark key={size} size={size} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const marks = [...canvasElement.querySelectorAll<SVGSVGElement>('svg.cd-mark')];
    await expect(marks.map((mark) => mark.getAttribute('width'))).toEqual(['16', '20', '24', '32', '36']);
    // mark_has_no_tile_on_a_dark_ground: no tile, and the drawing's ink drawn light.
    for (const mark of marks) await expectMark(mark, { tile: false, ink: LIGHT_INK });
  },
};

export const OnALightGround: Story = {
  parameters: {
    canvasNote:
      "N-Explore-Mark-Decided (signed 2026-10-30) draws the bell on a light ground in the drawing's dark ink, with no tile: the intro illustration's reply card.",
  },
  render: () => (
    <div style={{ display: 'inline-flex', padding: 'var(--space-16)', borderRadius: 'var(--radius-card)', background: 'var(--illustration-card)' }}>
      <DeskMark size={32} ground="light" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const mark = canvasElement.querySelector<SVGSVGElement>('svg.cd-mark') as SVGSVGElement;
    // mark_on_a_light_ground_keeps_the_dark_ink
    await expectMark(mark, { tile: false, ink: DARK_INK });
  },
};

export const WithTile: Story = {
  parameters: {
    canvasNote:
      "N-Explore-Mark-Decided (signed 2026-10-30) kept the white tile on the About pages' top bar; the owner moved it into the About pages' app icon the same day (N-Docs-Hero-Proposal, option A), the tile's only use (MarkAppIcon).",
  },
  render: () => <DeskMark tile />,
  play: async ({ canvasElement }) => {
    const mark = canvasElement.querySelector<SVGSVGElement>('svg.cd-mark') as SVGSVGElement;
    // mark_tile_keeps_the_dark_ink: the tile, then the bell in the drawing's own colors.
    await expect(mark.getAttribute('width')).toBe('20');
    await expectMark(mark, { tile: true, ink: DARK_INK });
  },
};

export const WithWordmark: Story = {
  parameters: {
    canvasNote:
      'The sidebar\u2019s lockup as the owner signed it on 2026-10-30: the 36 px bell, "Claude Desk" and the "Preview" badge in capitals, on one line.',
  },
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-10)' }}>
      <DeskMark size={36} />
      <Wordmark preview />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const name = canvas.getByText('Claude Desk');
    await expect(getComputedStyle(name).fontFamily).toMatch(/^"Source Serif 4"/);
    // wordmark_preview_is_a_caps_badge: "Preview" in the Pill, drawn in capitals, to the name's right.
    const badge = canvas.getByText('Preview');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-ds', 'preview-badge');
    expectComputed(badge, { textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.66px', height: '20px' });
    await expect(badge.getBoundingClientRect().left - name.getBoundingClientRect().right).toBe(8);
    await expect(canvasElement.querySelector('.cd-wordmark')?.textContent).toBe('Claude Desk Preview');
  },
};

export const AppIcon: Story = {
  parameters: {
    canvasNote:
      'N-Docs-Hero-Proposal and N-Docs-Hero-Proposal-Phone (option A, signed 2026-10-30) draw the app icon above the About pages\u2019 title: the tiled bell on a clay field, 120 px on a laptop and 88 px on a phone. The boards round the corners to 29 and 21 px and draw the bell at 79 px; here the corners are a quarter of the size, 30 and 22 px, and the bell 80 px.',
  },
  render: () => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-24)' }}>
      <MarkAppIcon size="large" />
      <MarkAppIcon size="compact" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // app_icon_is_the_tiled_bell_on_clay: decorative, a clay field with corners a quarter of its
    // size, and the bell on its white tile centred at two thirds of it.
    const icons = [...canvasElement.querySelectorAll<HTMLElement>('.cd-mark-app-icon')];
    await expect(icons).toHaveLength(2);
    for (const [icon, field, radius, bell] of [
      [icons[0], '120px', '30px', '80'],
      [icons[1], '88px', '22px', '58'],
    ] as const) {
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      expectComputed(icon as HTMLElement, { width: field, height: field, borderTopLeftRadius: radius, backgroundColor: 'rgb(224, 137, 104)' });
      const mark = icon?.querySelector<SVGSVGElement>(':scope > svg.cd-mark') as SVGSVGElement;
      await expect([mark.getAttribute('width'), mark.getAttribute('height')]).toEqual([bell, bell]);
      await expectMark(mark, { tile: true, ink: DARK_INK });
      const [outer, inner] = [(icon as HTMLElement).getBoundingClientRect(), mark.getBoundingClientRect()];
      await expect(inner.left - outer.left).toBe(outer.right - inner.right);
      await expect(inner.top - outer.top).toBe(outer.bottom - inner.bottom);
    }
  },
};
