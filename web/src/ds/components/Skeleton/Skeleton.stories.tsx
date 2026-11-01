import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { ANIMATION_DEADLINE_MS, animationWithin } from '../../test/animationWithin.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { partsOf, regionIn, watchRegion, type LayerState, type RegionParts } from '../../test/skeletonRegion.ts';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import { UNREACHABLE_COPY } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { PageHeader } from '../PageHeader/PageHeader.tsx';
import { PersonRow } from '../PersonRow/PersonRow.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { Skeleton, SkeletonCard, type SkeletonText } from './Skeleton.tsx';
import { SKELETON_DELAY_MS, SkeletonScreen } from './SkeletonScreen.tsx';

/** The visitor's chat board, at 390. */
const CHAT_BOARD_NOTE =
  'UXC-P1202-After (#artboard-d122e70134a0), the visitor\'s chat as shapes at 390, from the signed skeleton loading proposal; the footer stays real.';

/** The owner app's board: the frame and Today as shapes, then the real Today fading in over them. */
const OWNER_BOARD_NOTE =
  'UXC-P1201-After (#artboard-dec46cf506e4), from the signed skeleton loading proposal. The UXC boards are not in the reference list.';

const FILL_HOVER = 'rgba(250, 249, 245, 0.06)';

/** The band: transparent at both ends and fill-secondary at its centre, over the shape's fill-hover. */
const BAND = /^linear-gradient\(90deg, rgba\(0, 0, 0, 0\) 0px, rgba\(250, 249, 245, 0\.1\) 50%, rgba\(0, 0, 0, 0\) 100%\)$/;

/** One frame at 60 Hz: two sweeps in step are never further apart than this. */
const FRAME_MS = 17;

/**
 * How soon a layer goes once its fade ends or is cancelled: a few renders, and far sooner than the
 * fallback that removes a layer whose fade never reports back.
 */
const PROMPTLY_MS = 250;

/** Each line's type style, its line box and the pill centred in it, as the boards draw them. */
const LINES: readonly { text: SkeletonText; label: string; box: number; pill: number; width: number }[] = [
  { text: 'caption', label: 'Caption', box: 17, pill: 10, width: 220 },
  { text: 'meta', label: 'Meta', box: 18, pill: 10, width: 240 },
  { text: 'pill', label: 'Pill', box: 16, pill: 10, width: 64 },
  { text: 'body', label: 'Body', box: 20, pill: 12, width: 320 },
  { text: 'control', label: 'Control', box: 20, pill: 12, width: 140 },
  { text: 'section', label: 'Section', box: 20, pill: 12, width: 120 },
  { text: 'message', label: 'Message', box: 21, pill: 12, width: 280 },
  { text: 'reply', label: 'Reply', box: 23, pill: 12, width: 360 },
  { text: 'brand-name', label: 'Brand name', box: 22, pill: 14, width: 160 },
  { text: 'summary', label: 'Summary', box: 27, pill: 14, width: 420 },
  { text: 'page-title', label: 'Page title', box: 32, pill: 24, width: 200 },
  { text: 'figure-small', label: 'Figure, small', box: 32, pill: 24, width: 48 },
  { text: 'figure', label: 'Figure', box: 40, pill: 32, width: 120 },
  { text: 'greeting', label: 'Greeting', box: 44, pill: 36, width: 360 },
];

/** Blocks at each radius, with the computed corner each takes. */
const BLOCKS: readonly { radius: 'control' | 'card' | 'composer' | 'full'; label: string; width: number; height: number; corner: string }[] = [
  { radius: 'control', label: 'Block, control corners', width: 96, height: 32, corner: '8px' },
  { radius: 'card', label: 'Block, card corners', width: 240, height: 48, corner: '12px' },
  { radius: 'composer', label: 'Block, composer corners', width: 320, height: 48, corner: '16px' },
  { radius: 'full', label: 'Block, round ends', width: 200, height: 32, corner: '999px' },
];

/** The cards' paddings, as `Card`'s. */
const CARDS: readonly { padding: 0 | 16 | 20; label: string }[] = [
  { padding: 20, label: 'Card' },
  { padding: 16, label: 'Card, compact' },
  { padding: 0, label: 'Card of rows' },
];

/** One row of the contact sheet: its label, and its shape in the same row of the region. */
const ROW_STYLE = { display: 'flex', alignItems: 'center', minHeight: 64 } as const;

/** A card's row of the contact sheet, tall enough for the card of rows. */
const CARD_ROW_STYLE = { ...ROW_STYLE, minHeight: 152 } as const;

/** The lines the cards hold: two in each padded card, two in each of the card of rows' two rows. */
const CARD_LINES = 2 + 2 + 4;

/**
 * A row in a card of rows: it pads itself, 12 px by 16 px as a connector section's rows do, and
 * every row after the first sits under a hairline that runs to the card's edges.
 */
function CardRow({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return (
    <div
      className="story-card-row"
      style={{
        display: 'grid',
        gap: 'var(--space-2)',
        padding: 'var(--space-12) var(--space-16)',
        borderTop: first ? undefined : '1px solid var(--line-hairline)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * The shapes, one per row, each named at its left. The names sit outside the region, since a
 * skeleton draws no words of its own; both columns use the same rows, so each name sits by its shape.
 */
function ContactSheet() {
  const rows: { key: string; label: string; shape: ReactNode }[] = [
    ...LINES.map(({ text, label, width }) => ({
      key: `line-${text}`,
      label,
      shape: <Skeleton shape="line" text={text} width={width} anchor={`line-${text}`} />,
    })),
    { key: 'line-default', label: 'Body, full width', shape: <Skeleton shape="line" anchor="line-default" /> },
    ...BLOCKS.map(({ radius, label, width, height }) => ({
      key: `block-${radius}`,
      label,
      shape: <Skeleton shape="block" radius={radius} width={width} height={height} anchor={`block-${radius}`} />,
    })),
    { key: 'block-default', label: 'Block', shape: <Skeleton shape="block" width="50%" height={20} anchor="block-default" /> },
    { key: 'circle-default', label: 'Circle, avatar', shape: <Skeleton shape="circle" anchor="circle-default" /> },
    { key: 'circle-36', label: 'Circle, 36 px', shape: <Skeleton shape="circle" size={36} anchor="circle-36" /> },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', columnGap: 'var(--space-24)', maxWidth: 760 }}>
      <div>
        {rows.map(({ key, label }) => (
          <p key={key} className="cd-type-caption" style={{ ...ROW_STYLE, margin: 0, color: 'var(--text-secondary)' }}>
            {label}
          </p>
        ))}
        {CARDS.map(({ padding, label }) => (
          <p key={padding} className="cd-type-caption" style={{ ...CARD_ROW_STYLE, margin: 0, color: 'var(--text-secondary)' }}>
            {label}
          </p>
        ))}
      </div>
      <SkeletonScreen
        loading
        status="Opening your Desk"
        skeleton={
          <>
            {rows.map(({ key, shape }) => (
              <div key={key} style={ROW_STYLE}>
                {shape}
              </div>
            ))}
            {CARDS.map(({ padding }) => (
              <div key={padding} style={CARD_ROW_STYLE}>
                <SkeletonCard padding={padding} anchor={`card-${padding}`} className="story-skeleton-card">
                  {padding === 0 ? (
                    <>
                      <CardRow first>
                        <Skeleton shape="line" text="control" width={160} />
                        <Skeleton shape="line" text="caption" width={240} />
                      </CardRow>
                      <CardRow>
                        <Skeleton shape="line" text="control" width={130} />
                        <Skeleton shape="line" text="caption" width={210} />
                      </CardRow>
                    </>
                  ) : (
                    <>
                      <Skeleton shape="line" text="section" width={160} />
                      <Skeleton shape="line" text="caption" width={240} />
                    </>
                  )}
                </SkeletonCard>
              </div>
            ))}
          </>
        }
      />
    </div>
  );
}

const meta = {
  title: 'Status/Skeleton',
  component: Skeleton,
  args: { shape: 'line' },
  render: () => <ContactSheet />,
  parameters: { layout: 'padded', canvas: 'none', canvasNote: OWNER_BOARD_NOTE },
} satisfies Meta<typeof Skeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Every shape's own element: a line's box, a block, a circle and a card. */
const SHAPE_ROOTS = '.cd-skeleton-line, .cd-skeleton--block, .cd-skeleton--circle, .cd-skeleton-card';

/** The shape that carries `anchor`, or a thrown error naming the one that is missing. */
function anchored(root: HTMLElement, anchor: string): HTMLElement {
  const shape = root.querySelector<HTMLElement>(`[data-skeleton-anchor="${anchor}"]`);
  if (!shape) throw new Error(`no shape carries the anchor "${anchor}"`);
  return shape;
}

export const Shapes: Story = {
  play: async ({ canvasElement }) => {
    // skeleton_lines_take_their_line_box: each line is as tall as its type style's line height,
    // with the table's pill centred in it.
    for (const { text, box, pill, width } of LINES) {
      const line = anchored(canvasElement, `line-${text}`);
      const painted = line.querySelector<HTMLElement>('.cd-skeleton');
      if (!painted) throw new Error(`the ${text} line paints no pill`);
      const outer = line.getBoundingClientRect();
      const inner = painted.getBoundingClientRect();
      await expect([text, outer.width, outer.height]).toEqual([text, width, box]);
      await expect([text, inner.width, inner.height]).toEqual([text, width, pill]);
      await expect([text, inner.top - outer.top]).toEqual([text, (box - pill) / 2]);
      expectComputed(painted, { borderTopLeftRadius: '999px' });
    }
    // A line with no width fills its row; with no text it stands in for body.
    const fullWidth = anchored(canvasElement, 'line-default');
    const row = fullWidth.parentElement?.getBoundingClientRect();
    await expect(fullWidth.getBoundingClientRect().width).toBe(row?.width);
    await expect(fullWidth.getBoundingClientRect().height).toBe(20);

    // Blocks take their sizes and radii, control corners by default; circles their diameters.
    for (const { radius, width, height, corner } of BLOCKS) {
      const block = anchored(canvasElement, `block-${radius}`);
      const rect = block.getBoundingClientRect();
      await expect([radius, rect.width, rect.height]).toEqual([radius, width, height]);
      expectComputed(block, { borderTopLeftRadius: corner, borderBottomRightRadius: corner });
    }
    const half = anchored(canvasElement, 'block-default');
    await expect(half.getBoundingClientRect().width).toBe((half.parentElement?.getBoundingClientRect().width ?? 0) / 2);
    expectComputed(half, { height: '20px', borderTopLeftRadius: '8px' });
    expectComputed(anchored(canvasElement, 'circle-default'), { width: '28px', height: '28px', borderTopLeftRadius: '999px' });
    expectComputed(anchored(canvasElement, 'circle-36'), { width: '36px', height: '36px', borderTopLeftRadius: '999px' });

    // skeleton_card_is_the_real_card: Card's 1 px line-card border, fill-card, 12 px corners and padding.
    for (const { padding } of CARDS) {
      const card = anchored(canvasElement, `card-${padding}`);
      expectComputed(card, {
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'rgba(250, 249, 245, 0.14)',
        backgroundColor: 'rgba(250, 249, 245, 0.03)',
        borderTopLeftRadius: '12px',
        paddingTop: `${padding}px`,
        paddingLeft: `${padding}px`,
      });
      await expect(card).toHaveAttribute('aria-hidden', 'true');
      await expect(card.classList.contains('story-skeleton-card')).toBe(true);
    }

    // skeleton_card_of_rows_pads_its_rows: with no padding, the card holds rows that pad themselves,
    // 12 px by 16 px as a connector section's rows do, so the hairline between them runs edge to edge.
    const ofRows = anchored(canvasElement, 'card-0');
    const inner = ofRows.getBoundingClientRect();
    const rows = [...ofRows.querySelectorAll<HTMLElement>(':scope > .story-card-row')];
    await expect(rows).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      const box = row.getBoundingClientRect();
      await expect([box.left, box.right]).toEqual([inner.left + 1, inner.right - 1]);
      const first = row.querySelector<HTMLElement>('.cd-skeleton-line')?.getBoundingClientRect();
      const last = [...row.querySelectorAll<HTMLElement>('.cd-skeleton-line')].at(-1)?.getBoundingClientRect();
      if (!first || !last) throw new Error(`row ${i} of the card of rows holds no lines`);
      const hairline = i === 0 ? 0 : 1;
      await expect([first.left - box.left, first.top - box.top - hairline, box.bottom - last.bottom]).toEqual([16, 12, 12]);
      expectComputed(row, i === 0 ? { borderTopWidth: '0px' } : { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    }

    // Every shape paints fill-hover, and every shape is hidden from assistive technology.
    const painted = [...canvasElement.querySelectorAll<HTMLElement>('.cd-skeleton')];
    await expect(painted.length).toBe(LINES.length + 1 + BLOCKS.length + 1 + 2 + CARD_LINES);
    for (const shape of painted) expectComputed(shape, { backgroundColor: FILL_HOVER });
    const shapes = [...canvasElement.querySelectorAll<HTMLElement>(SHAPE_ROOTS)];
    await expect(shapes.length).toBe(painted.length + CARDS.length);
    for (const shape of shapes) await expect(shape).toHaveAttribute('aria-hidden', 'true');
    // A shape carries data-skeleton-anchor when it is given an anchor, and only then.
    const anchors = [...canvasElement.querySelectorAll<HTMLElement>('[data-skeleton-anchor]')];
    await expect(anchors.length).toBe(LINES.length + 1 + BLOCKS.length + 1 + 2 + CARDS.length);
    for (const line of canvasElement.querySelectorAll<HTMLElement>('.story-skeleton-card .cd-skeleton-line')) {
      await expect(line).not.toHaveAttribute('data-skeleton-anchor');
    }
  },
};

/** A part that mounts `after` ms after the rest, as a page's later read would. */
function Later({ after, children }: { after: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), after);
    return () => clearTimeout(timer);
  }, [after]);
  return shown ? children : null;
}

/**
 * A row of Things to try: its icon tile, its title and line, and its next step at the right. It pads
 * itself, and every row after the first sits under a hairline that runs to the card's edges.
 */
function ThingRow({ anchor, first = false }: { anchor?: string; first?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-12)',
        padding: 'var(--space-14) var(--space-16)',
        borderTop: first ? undefined : '1px solid var(--line-hairline)',
      }}
    >
      <Skeleton shape="block" width={32} height={32} anchor={anchor} />
      <div style={{ display: 'grid', gap: 'var(--space-2)', flex: 1, minWidth: 0 }}>
        <Skeleton shape="line" text="control" width="45%" />
        <Skeleton shape="line" text="caption" width="70%" />
      </div>
      <Skeleton shape="block" width={88} height="var(--size-control)" />
    </div>
  );
}

/**
 * The head of Today as shapes, as the signed board draws it: the greeting and its presence line,
 * the link pill, then Things to try's heading, its line and its card of rows. Needs you's heading
 * and its card mount 300 ms after the rest.
 */
function TodayHead() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-32)', maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 'var(--space-8)' }}>
        <Skeleton shape="line" text="greeting" width={380} anchor="greeting" />
        <Skeleton shape="line" text="body" width={300} />
        <Skeleton shape="block" radius="full" width={260} height="var(--size-control)" />
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-12)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
          <Skeleton shape="line" text="section" width={110} />
          <Skeleton shape="line" text="meta" width={150} />
        </div>
        <SkeletonCard padding={0}>
          <ThingRow anchor="first-tile" first />
          <ThingRow />
          <ThingRow />
          <ThingRow />
        </SkeletonCard>
      </div>
      <Later after={300}>
        <div style={{ display: 'grid', gap: 'var(--space-12)' }}>
          <Skeleton shape="line" text="section" width={90} anchor="later" />
          <SkeletonCard>
            <div style={{ display: 'grid', gap: 'var(--space-8)' }}>
              <Skeleton shape="line" text="caption" width="40%" />
              <Skeleton shape="line" text="summary" width="85%" />
              <Skeleton shape="line" text="body" width="60%" />
            </div>
          </SkeletonCard>
        </div>
      </Later>
    </div>
  );
}

/** The sweep's animation on a shape that paints, or a thrown error when it has none. */
function sweepOf(shape: HTMLElement): CSSAnimation {
  const painted = shape.classList.contains('cd-skeleton') ? shape : shape.querySelector<HTMLElement>('.cd-skeleton');
  const sweep = painted
    ?.getAnimations()
    .find((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.animationName === 'cd-skeleton-sweep');
  if (!sweep) throw new Error('the shape runs no cd-skeleton-sweep');
  return sweep;
}

export const Sweep: Story = {
  render: () => <SkeletonScreen loading status="Opening your Desk" skeleton={<TodayHead />} />,
  play: async ({ canvasElement }) => {
    const later = await waitFor(() => anchored(canvasElement, 'later'), { timeout: ANIMATION_DEADLINE_MS });

    // skeleton_sweeps_one_band: every shape paints fill-hover under one band, transparent at both
    // ends and fill-secondary at its centre, 900 px wide, moved on the writing loop at an even speed.
    const painted = [...canvasElement.querySelectorAll<HTMLElement>('.cd-skeleton')];
    await expect(painted.length).toBeGreaterThan(20);
    for (const shape of painted) {
      expectComputed(shape, {
        backgroundColor: FILL_HOVER,
        backgroundImage: BAND,
        backgroundSize: '900px 100%',
        backgroundRepeat: 'no-repeat',
        backgroundPositionY: '0px',
        animationName: 'cd-skeleton-sweep',
        animationDuration: '1.6s',
        animationTimingFunction: 'linear',
        animationIterationCount: 'infinite',
      });
    }

    // sweeps_share_one_phase: a shape mounted 300 ms after another shows the band at the same moment.
    const first = sweepOf(anchored(canvasElement, 'greeting'));
    const late = sweepOf(later);
    await expect(Math.abs(Number(first.currentTime) - Number(late.currentTime))).toBeLessThanOrEqual(FRAME_MS);
  },
};

/**
 * Customers as shapes, built from the list's own classes: the section's heading, then the seed's two
 * people on record, each row a `cd-person-row` holding a name and a contact line.
 */
function CustomersShapes() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-12)' }}>
      <Skeleton shape="line" text="section" width={150} anchor="heading" />
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        {['first-row', 'last-row'].map((anchor, i) => (
          <div key={anchor} className="cd-person-row" data-skeleton-anchor={anchor}>
            <Skeleton shape="line" text="control" width={[90, 120][i]} />
            <Skeleton shape="line" text="caption" width={[200, 200][i]} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Customers drawn: the section's heading and the people on record. */
function CustomersLanded({ children }: { children?: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-12)' }}>
      <SectionHeader title="Contacts on record" count={{ n: 2, label: '2 contacts on record' }} />
      <ul role="list" aria-label="Contacts on record" style={{ display: 'grid', gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none' }}>
        {[rivera.people.bob, rivera.people.dana].map((person) => (
          <li key={person.personId}>
            <PersonRow name={person.name} contact={person.maskedContact} />
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/** A part of a page that loads for `loadsAfter` ms (for good, when null), then draws its children. */
function Loads({
  loadsAfter,
  status,
  skeleton,
  lang,
  children,
}: {
  loadsAfter: number | null;
  status: string;
  skeleton: ReactNode;
  lang?: string;
  children?: ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (loadsAfter === null) return;
    const timer = setTimeout(() => setLoading(false), loadsAfter);
    return () => clearTimeout(timer);
  }, [loadsAfter]);
  return (
    <SkeletonScreen loading={loading} status={status} skeleton={skeleton} lang={lang}>
      {children}
    </SkeletonScreen>
  );
}

/** A page's column: the region, then the concept footer under it, which must not move. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-32)', maxWidth: 760 }}>
      {children}
      <ConceptFooter />
    </div>
  );
}

function footerOf(root: HTMLElement): DOMRect {
  const footer = root.querySelector('.cd-concept-footer');
  if (!footer) throw new Error('no concept footer under the region');
  return footer.getBoundingClientRect();
}

export const Waits: Story = {
  render: () => (
    <Column>
      <Loads loadsAfter={null} status="Loading your customers" skeleton={<CustomersShapes />} />
    </Column>
  ),
  play: async ({ mount, canvasElement }) => {
    const watch = watchRegion(canvasElement);
    await mount();
    try {
      // skeleton_waits_before_it_shows: at mount the layer is laid out but invisible, the status is
      // empty and the body is busy.
      const { status, body, layer } = partsOf(regionIn(canvasElement) as HTMLElement);
      await expect(watch.states.map((entry) => entry.state)).toEqual(['waiting']);
      if (!layer) throw new Error('the region has no layer while it loads');
      expectComputed(layer, { visibility: 'hidden' });
      await expect(layer).toHaveAttribute('aria-hidden', 'true');
      await expect(layer.hasAttribute('inert')).toBe(true);
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status.classList.contains('cd-sr-only')).toBe(true);
      await expect(status.textContent).toBe('');
      await expect(body).toHaveAttribute('aria-busy', 'true');
      // It already holds its height, so nothing under it moves when it shows.
      await expect(layer.getBoundingClientRect().height).toBeGreaterThan(100);
      const footerBefore = footerOf(canvasElement);

      // It shows no sooner than SKELETON_DELAY_MS after it appeared, and the status says what is loading.
      const shown = await watch.reached('shown');
      await expect(shown.at - watch.appeared()).toBeGreaterThanOrEqual(SKELETON_DELAY_MS);
      expectComputed(layer, { visibility: 'visible' });
      await expect(status.textContent).toBe('Loading your customers');
      await expect(body).toHaveAttribute('aria-busy', 'true');
      await expect(footerOf(canvasElement).toJSON()).toEqual(footerBefore.toJSON());
    } finally {
      watch.stop();
    }
  },
};

/** Resolves after `ms`, for a test that must let a moment pass. */
function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Records every fade the layer starts under `root`: the shapes' sweeps don't count. */
function watchFades(root: HTMLElement) {
  const fades: string[] = [];
  const onStart = (event: AnimationEvent) => {
    if (event.animationName === 'cd-skeleton-leave') fades.push(event.animationName);
  };
  root.addEventListener('animationstart', onStart);
  return { fades, stop: () => root.removeEventListener('animationstart', onStart) };
}

/** The landed list of people on record. */
function landedList(root: HTMLElement): HTMLElement {
  const list = root.querySelector<HTMLElement>('ul[aria-label="Contacts on record"]');
  if (!list) throw new Error('the people on record are not drawn');
  return list;
}

export const FastLoad: Story = {
  render: () => (
    <Column>
      <Loads loadsAfter={100} status="Loading your customers" skeleton={<CustomersShapes />}>
        <CustomersLanded />
      </Loads>
    </Column>
  ),
  play: async ({ mount, canvasElement }) => {
    const watch = watchRegion(canvasElement);
    const fades = watchFades(canvasElement);
    await mount();
    try {
      // fast_load_goes_straight_to_the_page: the load ends at 100 ms, inside the wait, so the
      // shapes never show and nothing fades; the people draw in their place.
      await waitFor(() => landedList(canvasElement), { timeout: ANIMATION_DEADLINE_MS });
      await pause(SKELETON_DELAY_MS * 2);
      await expect(watch.states.map((entry) => entry.state)).toEqual(['waiting', 'gone']);
      await expect(fades.fades).toEqual([]);
      const { status, body, layer } = partsOf(regionIn(canvasElement) as HTMLElement);
      await expect(layer).toBeNull();
      await expect(body).not.toHaveAttribute('aria-busy');
      await expect(status.textContent).toBe('');
    } finally {
      watch.stop();
      fades.stop();
    }
  },
};

/** Clicks on the landed page's button, which must work while the skeleton fades over it. */
const opened = fn();

/** The fade on a leaving layer, or a thrown error when it runs none. */
function fadeOf(layer: HTMLElement): CSSAnimation {
  const fade = layer
    .getAnimations()
    .find((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.animationName === 'cd-skeleton-leave');
  if (!fade) throw new Error('the leaving layer runs no cd-skeleton-leave');
  return fade;
}

/** What a region looks like in the frame its layer turns `leaving`, before the fade has moved. */
interface LeavingMoment {
  region: DOMRect;
  layer: DOMRect;
  part: DOMRect;
  heading: DOMRect;
  /** The real elements that stand where the heading's and the rows' shapes were, when they drew. */
  landed: { heading: DOMRect | null; rows: DOMRect[] };
  /** What a pointer at the centre of the landed button would hit. */
  hit: Element | null;
  fade: CSSAnimation;
  parts: RegionParts;
}

/**
 * Watches a region that lands: the heading shape's rect while shown, and the leaving frame as
 * React commits it, with the fade held at its start so the play can look at it.
 */
function watchLanding(root: HTMLElement) {
  let headingShown: DOMRect | null = null;
  let leaving: LeavingMoment | null = null;
  const watch = watchRegion(root, (state, parts) => {
    if (state === 'shown') headingShown = anchored(root, 'heading').getBoundingClientRect();
    if (state !== 'leaving' || !parts.layer) return;
    const fade = fadeOf(parts.layer);
    fade.pause();
    const part = parts.layer.nextElementSibling;
    const button = root.querySelector<HTMLElement>('.cd-skeleton-screen button');
    if (!part || !button) throw new Error('the part did not draw under the leaving layer');
    const box = button.getBoundingClientRect();
    leaving = {
      region: parts.region.getBoundingClientRect(),
      layer: parts.layer.getBoundingClientRect(),
      part: part.getBoundingClientRect(),
      heading: anchored(root, 'heading').getBoundingClientRect(),
      landed: {
        heading: part.querySelector('h2')?.getBoundingClientRect() ?? null,
        rows: [...part.querySelectorAll('li > .cd-person-row')].map((row) => row.getBoundingClientRect()),
      },
      hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
      fade,
      parts,
    };
  });
  return {
    ...watch,
    headingShown: () => headingShown,
    leaving: () => leaving,
  };
}

/** The leaving frame: the layer over the part at its top-left, faded on motion-fast, with clicks passing through. */
async function expectLeavesOverThePart(moment: LeavingMoment | null, headingShown: DOMRect | null) {
  if (!moment || !headingShown) throw new Error('the layer never turned leaving after it showed');
  const { region, layer, part, heading, fade, parts } = moment;
  // The layer lies over the part, both at the region's top-left, and no shape has moved.
  await expect([layer.top, layer.left]).toEqual([region.top, region.left]);
  await expect([part.top, part.left]).toEqual([region.top, region.left]);
  await expect(heading.toJSON()).toEqual(headingShown.toJSON());
  // The fade: 120 ms, ease-out, from opacity 1 to 0, on a layer that takes no pointer and no focus.
  const layerElement = parts.layer as HTMLElement;
  expectComputed(layerElement, {
    position: 'absolute',
    zIndex: '1',
    overflow: 'hidden',
    pointerEvents: 'none',
    backgroundColor: 'rgb(28, 27, 25)',
    animationName: 'cd-skeleton-leave',
    animationDuration: '0.12s',
    animationTimingFunction: 'ease-out',
  });
  const keyframes = fade.effect instanceof KeyframeEffect ? fade.effect.getKeyframes() : [];
  await expect(keyframes.map(({ offset, opacity }) => [offset, opacity])).toEqual([
    [0, '1'],
    [1, '0'],
  ]);
  await expect(layerElement.hasAttribute('inert')).toBe(true);
  expectComputed(parts.region, { position: 'relative' });
  // The load is over: the body is no longer busy, and the status has nothing more to say.
  await expect(parts.body).not.toHaveAttribute('aria-busy');
  await expect(parts.status.textContent).toBe('');
}

/** Afterwards: no layer, nothing busy, an empty status and a region with no position of its own. */
async function expectLanded(root: HTMLElement) {
  const { region, status, body, layer } = partsOf(regionIn(root) as HTMLElement);
  await expect(layer).toBeNull();
  await expect(body).not.toHaveAttribute('aria-busy');
  await expect(status.textContent).toBe('');
  expectComputed(region, { position: 'static' });
}

export const Lands: Story = {
  render: () => (
    <Column>
      <Loads loadsAfter={600} status="Loading your customers" skeleton={<CustomersShapes />}>
        <CustomersLanded>
          <div>
            <Button variant="secondary" onClick={opened}>
              Open your public page
            </Button>
          </div>
        </CustomersLanded>
      </Loads>
    </Column>
  ),
  play: async ({ mount, canvasElement }) => {
    opened.mockClear();
    const watch = watchLanding(canvasElement);
    await mount();
    try {
      await watch.reached('shown');
      await watch.reached('leaving');
      // skeleton_fades_over_the_page: the page draws under the layer, which fades over it.
      const moment = watch.leaving();
      await expectLeavesOverThePart(moment, watch.headingShown());
      // Built from the list's own classes, the shapes stood where the people land: nothing jumps.
      const shapes = [moment?.heading, ...['first-row', 'last-row'].map((anchor) => anchored(canvasElement, anchor).getBoundingClientRect())];
      const landed = [moment?.landed.heading, ...(moment?.landed.rows ?? [])];
      await expect(landed).toHaveLength(3);
      for (const [i, real] of landed.entries()) {
        const shape = shapes[i];
        if (!real || !shape) throw new Error(`no landed element or shape at ${i}`);
        await expect(Math.abs(real.top - shape.top)).toBeLessThanOrEqual(2);
        await expect(Math.abs(real.left - shape.left)).toBeLessThanOrEqual(2);
      }
      // A click during the fade lands on the page's button, not on the layer.
      const button = canvasElement.querySelector<HTMLElement>('.cd-skeleton-screen button');
      await expect(moment?.hit !== null && moment?.hit !== undefined && button?.contains(moment.hit)).toBe(true);
      await userEvent.click(button as HTMLElement);
      await expect(opened).toHaveBeenCalledTimes(1);
      await expect(watch.states.at(-1)?.state).toBe('leaving');

      // Seek to the end rather than waiting for 120 ms of composited frames. The browser still
      // delivers the fade's own end, which must remove the layer well before the fallback.
      if (!moment) throw new Error('no leaving frame to finish');
      const ended = animationWithin(moment.fade.finished.then(() => performance.now()), 'cd-skeleton-leave finish');
      moment.fade.finish();
      const endedAt = await ended;
      const gone = await watch.reached('gone', ANIMATION_DEADLINE_MS);
      await expect(gone.at - endedAt).toBeLessThan(PROMPTLY_MS);
      await expect(watch.states.map((entry) => entry.state)).toEqual(['waiting', 'shown', 'leaving', 'gone']);
      await expectLanded(canvasElement);
      landedList(canvasElement);
    } finally {
      watch.stop();
    }
  },
};

/** The Customers page's header, as the page draws it. */
const CUSTOMERS_SUBTITLE = 'Leads and customers on this Desk. Verified means a code reached their contact on record.';

/**
 * A reload of Customers: the whole page as shapes while the Desk opens, then the real header with
 * Customers' own region under it, which continues the shapes while the people are read.
 */
function CustomersReload() {
  return (
    <Column>
      <Loads
        loadsAfter={600}
        status="Opening your Desk"
        skeleton={
          <div style={{ display: 'grid', gap: 'var(--space-24)' }}>
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Skeleton shape="line" text="page-title" width={150} />
              <Skeleton shape="line" text="body" width={520} />
            </div>
            <CustomersShapes />
          </div>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--space-24)' }}>
          <PageHeader title="Customers" subtitle={CUSTOMERS_SUBTITLE} />
          <Loads loadsAfter={null} status="Loading your customers" skeleton={<CustomersShapes />} />
        </div>
      </Loads>
    </Column>
  );
}

export const Continues: Story = {
  render: () => <CustomersReload />,
  play: async ({ mount, canvasElement }) => {
    // skeleton_continues_at_a_hand_off: a region that mounts while the one around it is leaving
    // shows its shapes in its first frame, with no wait, so no frame goes without shapes.
    let firstFrame: { state: string | undefined; status: string | null; outer: LayerState } | null = null;
    const watch = watchRegion(canvasElement, (state) => {
      const inner = canvasElement.querySelectorAll<HTMLElement>('.cd-skeleton-screen')[1];
      if (!inner || firstFrame) return;
      const parts = partsOf(inner);
      firstFrame = { state: parts.layer?.dataset.state, status: parts.status.textContent, outer: state };
    });
    await mount();
    try {
      await watch.reached('leaving');
      await expect(firstFrame).toEqual({ state: 'shown', status: 'Loading your customers', outer: 'leaving' });
      // The outer region lands; the inner one keeps its shapes while the people are read.
      await watch.reached('gone', ANIMATION_DEADLINE_MS);
      const inner = partsOf(canvasElement.querySelectorAll<HTMLElement>('.cd-skeleton-screen')[1] as HTMLElement);
      await expect(inner.layer?.dataset.state).toBe('shown');
      await expect(inner.body).toHaveAttribute('aria-busy', 'true');
    } finally {
      watch.stop();
    }
  },
};

export const Fails: Story = {
  render: () => (
    <Column>
      <Loads loadsAfter={600} status="Loading your customers" skeleton={<CustomersShapes />}>
        <Notice tone="error" action={<Button variant="secondary">Try again</Button>}>
          {UNREACHABLE_COPY.en}
        </Notice>
      </Loads>
    </Column>
  ),
  play: async ({ mount, canvasElement }) => {
    const watch = watchLanding(canvasElement);
    await mount();
    try {
      await watch.reached('leaving');
      // skeleton_ends_on_a_failed_read: the read failed, so the error and "Try again" land where the
      // shapes were, as a page would, and the layer leaves over them as it does over a page.
      const moment = watch.leaving();
      await expectLeavesOverThePart(moment, watch.headingShown());
      const region = regionIn(canvasElement) as HTMLElement;
      const notice = region.querySelector<HTMLElement>('[role="alert"]');
      await expect(notice?.textContent).toBe(`${UNREACHABLE_COPY.en}Try again`);

      // Seek the held fade into its active interval: animationstart can be skipped or delivered
      // before a listener attaches. Sampling its opacity proves it started without that event or
      // real-time frames. Cancelling it must reveal opacity 0 and remove it before the fallback.
      if (!moment) throw new Error('no leaving frame to cancel');
      const { fade } = moment;
      const layer = moment.parts.layer as HTMLElement;
      await animationWithin(fade.ready, 'cd-skeleton-leave pause');
      fade.currentTime = 60;
      const fadingOpacity = Number(getComputedStyle(layer).opacity);
      await expect(fadingOpacity).toBeGreaterThan(0);
      await expect(fadingOpacity).toBeLessThan(1);
      fade.cancel();
      const cancelled = performance.now();
      expectComputed(layer, { opacity: '0' });
      const gone = await watch.reached('gone', ANIMATION_DEADLINE_MS);
      await expect(gone.at - cancelled).toBeLessThan(PROMPTLY_MS);
      await expectLanded(canvasElement);
      await expect(region.contains(notice)).toBe(true);
    } finally {
      watch.stop();
    }
  },
};

/**
 * The visitor's chat as shapes, as the signed board draws it at 390: the brand header, the chat's
 * head where the disclosure goes, a visitor's bubble at the right, Claude's lines at the left and the
 * composer. Nothing on it states anything.
 */
function ChatShapes() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-20)' }}>
      <Skeleton shape="block" radius="card" height="var(--size-brand-header)" anchor="brand-header" />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Skeleton shape="line" text="caption" width="90%" anchor="disclosure" />
        <Skeleton shape="line" text="caption" width="55%" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Skeleton shape="block" radius="card" width="60%" height={37} />
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <Skeleton shape="line" text="reply" width="95%" />
        <Skeleton shape="line" text="reply" width="88%" />
        <Skeleton shape="line" text="reply" width="40%" />
        <Skeleton shape="line" text="caption" width="50%" />
      </div>
      <Skeleton shape="block" radius="composer" height={52} anchor="composer" />
    </div>
  );
}

export const Spanish: Story = {
  render: () => (
    <div lang="es">
      <Column>
        <Loads loadsAfter={null} status="Abriendo el chat" lang="es" skeleton={<ChatShapes />} />
      </Column>
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: CHAT_BOARD_NOTE },
  play: async ({ mount, canvasElement }) => {
    const watch = watchRegion(canvasElement);
    await mount();
    try {
      // public_chat_opens_in_spanish: the hidden status is the visitor's own loading words, in their
      // language, once the shapes show; the skeleton draws no words, and the footer stays real.
      const { status, layer } = partsOf(regionIn(canvasElement) as HTMLElement);
      await expect(status.textContent).toBe('');
      await watch.reached('shown');
      await expect(status.textContent).toBe('Abriendo el chat');
      await expect(status).toHaveAttribute('lang', 'es');
      await expect(layer?.textContent).toBe('');
      await expect(canvasElement.querySelector('[data-ds="concept-footer"]')?.closest('.cd-skeleton-screen')).toBeNull();
    } finally {
      watch.stop();
    }
  },
};
