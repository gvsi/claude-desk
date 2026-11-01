/**
 * The About pages' figures in a real browser: what each one draws, the words it says, its text equivalent,
 * and that it passes the copy check and axe at the desktop and phone sizes. Expected words and values are
 * written out here, never read from the components.
 */
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { contrastRatio } from '../ds/contrast.ts';
import { assertCleanCopy } from '../ds/test/copy.ts';
import { placeholderTexts } from '../test/about.ts';
import { AXE_TAGS, tokenColor } from '../test/screen.ts';
import { ABOUT_DOCUMENTS, inlineText, type Block, type Inline } from './documents.ts';
import { ARCHITECTURE_LABELS, ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { MeasuresTable } from './figures/MeasuresTable.tsx';
import { ReadinessScale, readinessRows } from './figures/ReadinessScale.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { forgetPlayedFigures } from './figures/usePlayOnce.ts';

import './paper.css';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

afterEach(async () => {
  await page.viewport(DESKTOP.width, DESKTOP.height);
  // A figure that played in one test would draw complete in the next for that reason alone.
  forgetPlayedFigures();
  window.scrollTo(0, 0);
});

/** Waits `count` frames: long enough for an intersection observer to have heard a scroll. */
async function frames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * What under a figure moves or isn't drawn in full, as "tag (class): what": any element with an animation, and
 * any part of its drawing that is hidden, scaled or clipped. A complete, still figure has none.
 */
function motionUnder(figure: Element): string[] {
  const found: string[] = [];
  const name = (el: Element) => `${el.localName} (${el.getAttribute('class') ?? ''}${el.textContent ? `, ${el.textContent}` : ''})`;
  for (const el of [figure, ...figure.querySelectorAll('*')]) {
    const { animationName } = getComputedStyle(el);
    if (animationName !== 'none') found.push(`${name(el)}: animation ${animationName}`);
  }
  for (const part of figure.querySelectorAll('svg *:not(title)')) {
    const style = getComputedStyle(part);
    if (style.opacity !== '1') found.push(`${name(part)}: opacity ${style.opacity}`);
    if (style.transform !== 'none') found.push(`${name(part)}: transform ${style.transform}`);
    if (style.clipPath !== 'none') found.push(`${name(part)}: clip-path ${style.clipPath}`);
  }
  return found;
}

/** Each element's own `<title>`, as a tooltip shows it. */
function titles(elements: Element[]): string[] {
  return elements.map((el) => el.querySelector(':scope > title')?.textContent ?? '');
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The chart's scales, read off two of its points: Sonnet 4.5 (Sep 29, 2025, 25.3%) and Opus 5 (Jul 24, 2026,
 * 48.7%). `y(score)` is where a score sits; `days(x, iso)` is how many days `x` lies past the day `iso`.
 */
function chartScales(sonnet: Element | undefined, opus5: Element | undefined) {
  const at = (el: Element | undefined, name: 'cx' | 'cy') => Number(el?.getAttribute(name));
  const first = { t: Date.parse('2025-09-29T00:00:00Z'), x: at(sonnet, 'cx'), score: 25.3, y: at(sonnet, 'cy') };
  const last = { t: Date.parse('2026-07-24T00:00:00Z'), x: at(opus5, 'cx'), score: 48.7, y: at(opus5, 'cy') };
  const perDay = (last.x - first.x) / ((last.t - first.t) / DAY);
  return {
    y: (score: number) => first.y + ((score - first.score) / (last.score - first.score)) * (last.y - first.y),
    days: (x: number, iso: string) => (x - first.x) / perDay - (Date.parse(`${iso}T00:00:00Z`) - first.t) / DAY,
  };
}

/** Where a polyline first reaches the height `y` (scores rise as y falls), by straight lines between its points. */
function crossesAt(points: [number, number][], y: number): number | null {
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1] ?? [0, 0];
    const [x1, y1] = points[i] ?? [0, 0];
    if (y0 > y && y1 <= y) return x0 + ((y0 - y) / (y0 - y1)) * (x1 - x0);
  }
  return null;
}

/** Text under `root` that a person reads, one entry per text node, outside `aria-hidden` subtrees. */
function readTexts(root: Element): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[aria-hidden="true"]') || (node.textContent ?? '').trim() === ''
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const texts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push((node.textContent ?? '').trim());
  return texts;
}

/**
 * The v1 diagram's labels, as the kernel and safety session checked them: the figure's accessible name, then
 * every label it draws, in reading order. A change to any of them goes through that session first.
 */
const ARCHITECTURE_CHECKED = [
  'Claude proposes; the kernel decides what runs and what is shown',
  'Visitor',
  'or their agent',
  'Chat layer',
  'Claude proposes each action and drafts each reply',
  'No business credential',
  'Kernel',
  'Its own process; holds every business credential',
  'Decide',
  'Cedar rules compiled from the owner’s cards',
  'Runs',
  'Owner decides',
  'Refused',
  'Check reply',
  'Prices, dates and discounts only in typed cards',
  'Shown',
  'Handed off',
  'Signed ledger of every decision and check',
];

type Table = Extract<Block, { kind: 'table' }>;

/** The table right after a figure marker, or the first table not after one. */
function tableOf(blocks: Block[], after: 'readiness' | null): Table {
  const tables = blocks.flatMap((block, i) => {
    const before = blocks[i - 1];
    const marked = before?.kind === 'figure' && before.name === 'readiness';
    return block.kind === 'table' && (after === 'readiness') === marked ? [block] : [];
  });
  const table = tables[0];
  if (!table) throw new Error(`no table ${after ? `after the ${after} marker` : 'outside a figure'}`);
  return table;
}

const READINESS = tableOf(ABOUT_DOCUMENTS.prediction.blocks, 'readiness');

/** The seven Claude points as the leaderboard lists them, by release, then the top score. */
const CLAUDE_POINTS = [
  'Claude Sonnet 4.5, Sep 29, 2025: 25.3%',
  'Claude Opus 4.5, Nov 24, 2025: 24.7%',
  'Claude Opus 4.6, Feb 5, 2026: 27.3%',
  'Claude Opus 4.7, Apr 16, 2026: 40.2%',
  'Claude Opus 4.8, May 28, 2026: 39.7%',
  'Claude Fable 5, Jun 9, 2026: 39.7%',
  'Claude Opus 5, Jul 24, 2026: 48.7%',
];
const TOP_POINT = 'Qwen 3.8 Max, Jul 19, 2026: 55.2%, the top score';

describe('the about project', () => {
  it('about_project_runs_with_reduced_motion', () => {
    // How the figures play is checked in the about-motion project's files, which this project leaves out.
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  });
});

describe('Tau3Chart', () => {
  it('chart_shows_the_leaderboard', async () => {
    const primary = tokenColor('--text-primary');
    const secondary = tokenColor('--text-secondary');
    const panel = tokenColor('--bg-panel');

    for (const compact of [false, true]) {
      const screen = await render(<Tau3Chart compact={compact} />);
      const svg = screen.container.querySelector('svg[role="img"]');
      expect(svg, `compact ${compact}`).not.toBeNull();
      if (!svg) continue;

      // Seven filled points in primary ink, values in their titles.
      const filled = [...svg.querySelectorAll('[data-point="claude"]')];
      expect(titles(filled)).toEqual(CLAUDE_POINTS);
      for (const point of filled) expect(getComputedStyle(point).fill).toBe(primary);

      // One hollow point in secondary ink: the top score.
      const hollow = [...svg.querySelectorAll('[data-point="top"]')];
      expect(titles(hollow)).toEqual([TOP_POINT]);
      for (const point of hollow) {
        expect(getComputedStyle(point).fill).toBe(panel);
        expect(getComputedStyle(point).stroke).toBe(secondary);
      }

      // The latest Claude point, Opus 5, ringed.
      const ring = svg.querySelector('[data-ring]');
      const opus5 = filled.at(-1);
      expect(ring?.getAttribute('cx')).toBe(opus5?.getAttribute('cx'));
      expect(ring?.getAttribute('cy')).toBe(opus5?.getAttribute('cy'));

      // Direct labels only on Opus 4.5, Opus 5 and the top score; a phone keeps the short ones.
      const labels = [...svg.querySelectorAll('[data-point-label]')].map((label) => label.textContent);
      expect(labels).toEqual(
        compact ? ['24.7%', 'Opus 5 48.7%'] : ['Top score, Qwen 3.8 Max 55.2%', 'Opus 4.5 24.7%', 'Opus 5 48.7%'],
      );

      // The fit, the 80% bar and the band are drawn once each, where the text puts them. The chart's scales
      // come from two of its own points: Sonnet 4.5 (Sep 29, 2025, 25.3%) and Opus 5 (Jul 24, 2026, 48.7%).
      expect(svg.querySelectorAll('[data-fit]')).toHaveLength(1);
      expect(svg.querySelectorAll('[data-bar]')).toHaveLength(1);
      expect(svg.querySelectorAll('[data-band]')).toHaveLength(1);
      const scales = chartScales(filled[0], filled.at(-1));
      // The bar at 80%.
      const bar = Number(svg.querySelector('[data-bar]')?.getAttribute('y1'));
      expect(Math.abs(bar - scales.y(80)), `compact ${compact}: the bar's y`).toBeLessThan(0.5);
      // The band from the best-score fit's crossing (Apr 20, 2027) to the all-seven fit's (Oct 3, 2027).
      const band = svg.querySelector('[data-band]');
      const left = Number(band?.getAttribute('x'));
      const right = left + Number(band?.getAttribute('width'));
      expect(Math.abs(scales.days(left, '2027-04-20')), `compact ${compact}: the band's left edge`).toBeLessThan(1.5);
      expect(Math.abs(scales.days(right, '2027-10-03')), `compact ${compact}: the band's right edge`).toBeLessThan(1.5);
      // The all-seven fit runs from Opus 5 and reaches the bar near Oct 3, 2027.
      const fit = (svg.querySelector('[data-fit]')?.getAttribute('points') ?? '')
        .split(' ')
        .map((pair) => pair.split(',').map(Number) as [number, number]);
      expect(fit[0]?.[0]).toBe(Number(filled.at(-1)?.getAttribute('cx')));
      const crossing = crossesAt(fit, bar);
      expect(crossing, `compact ${compact}: the fit reaches the bar`).not.toBeNull();
      expect(Math.abs(scales.days(crossing ?? 0, '2027-10-03')), `compact ${compact}: where the fit reaches the bar`).toBeLessThan(3);

      // Under it, "Figure 1" and the caption with the source.
      const caption = screen.container.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim();
      expect(caption).toBe(
        compact
          ? 'Figure 1 Seven Claude releases on Sierra’s τ³-Banking leaderboard; Opus 4.5 to Opus 5 rose from 24.7% to 48.7% in eight months. The dashed line is a straight-line fit in log-odds through all seven; the band is where the fits in the text cross 80%. Source: taubench.com.'
          : 'Figure 1 Seven Claude releases on Sierra’s τ³-Banking leaderboard; Opus 4.5 to Opus 5 rose from 24.7% to 48.7% in eight months. The dashed line is a straight-line fit in log-odds through all seven; the shaded band is where the fits in the text cross 80%. Source: taubench.com, pass^1 as listed.',
      );
      await screen.unmount();
    }
  });

  it('chart_is_complete_under_reduced_motion', async () => {
    // Below the fold, then in view: under reduced motion the chart never plays, and is drawn complete throughout.
    const screen = await render(
      <>
        <div style={{ height: '150vh' }} />
        <Tau3Chart />
        <div style={{ height: '150vh' }} />
      </>,
    );
    const figure = screen.container.querySelector('figure');
    if (!figure) throw new Error('no figure');
    await frames();
    expect(figure.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    expect(figure.hasAttribute('data-play'), 'below the fold').toBe(false);
    expect(motionUnder(figure), 'below the fold').toEqual([]);

    figure.scrollIntoView({ block: 'center' });
    await frames();
    expect(figure.hasAttribute('data-play'), 'in view').toBe(false);
    expect(motionUnder(figure), 'in view').toEqual([]);
  });

  it('chart_has_a_text_equivalent', async () => {
    for (const compact of [false, true]) {
      const screen = await render(<Tau3Chart compact={compact} />);
      const svg = screen.container.querySelector('svg[role="img"]');
      const describedBy = svg?.getAttribute('aria-describedby') ?? '';
      const description = describedBy ? document.getElementById(describedBy) : null;
      expect(description, `compact ${compact}`).not.toBeNull();
      if (!description) continue;

      // Visually hidden, still read.
      expect(description.closest('.cd-sr-only'), `compact ${compact}`).not.toBeNull();

      // A table of all eight points: model, date, score.
      const rows = [...description.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => cell.textContent),
      );
      expect([...description.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
        'Model',
        'Released',
        'pass^1',
      ]);
      expect(rows).toEqual([
        ['Claude Sonnet 4.5', 'Sep 29, 2025', '25.3%'],
        ['Claude Opus 4.5', 'Nov 24, 2025', '24.7%'],
        ['Claude Opus 4.6', 'Feb 5, 2026', '27.3%'],
        ['Claude Opus 4.7', 'Apr 16, 2026', '40.2%'],
        ['Claude Opus 4.8', 'May 28, 2026', '39.7%'],
        ['Claude Fable 5', 'Jun 9, 2026', '39.7%'],
        ['Qwen 3.8 Max, the top score', 'Jul 19, 2026', '55.2%'],
        ['Claude Opus 5', 'Jul 24, 2026', '48.7%'],
      ]);

      // And one sentence on the fit and the band.
      expect(description.querySelector('p')?.textContent).toBe(
        'The dashed line, a straight-line fit in log-odds through all seven Claude scores, reaches 80% in October 2027; the band runs from April 2027, where the fit through the best score across labs reaches 80%, to October 2027.',
      );
      await screen.unmount();
    }
  });
});

describe('ArchitectureFigure', () => {
  it('architecture_labels_are_the_checked_list', async () => {
    const [name, ...labels] = ARCHITECTURE_CHECKED;
    // The component's list, which other checks of the page read, is the checked one.
    expect(Object.values(ARCHITECTURE_LABELS)).toEqual(ARCHITECTURE_CHECKED);
    for (const compact of [false, true]) {
      const screen = await render(<ArchitectureFigure compact={compact} />);

      // The figure is named by the first label, exactly.
      await expect.element(screen.getByRole('figure', { name, exact: true })).toBeInTheDocument();

      // The diagram says the rest, in order, and nothing else.
      const diagram = screen.container.querySelector('[data-diagram]');
      expect(diagram, `compact ${compact}`).not.toBeNull();
      if (diagram) expect(readTexts(diagram)).toEqual(labels);

      // The caption: the figure's number, the reader's own words, and the name.
      const caption = screen.container.querySelector('figcaption');
      expect(caption?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        `Figure 1 The first release’s architecture: two processes, two checkpoints. ${name}.`,
      );
      await screen.unmount();
    }
  });

  it('architecture_is_still_under_reduced_motion', async () => {
    // Below the fold, then in view: under reduced motion the figure never traces its path, and nothing in it moves
    // or is lit (an outline in secondary ink on a hover ground) at any point.
    const lit = `${tokenColor('--text-secondary')} 0px 0px 0px 1px inset`;
    const hover = tokenColor('--fill-hover');
    const litUnder = (figure: Element) =>
      [...figure.querySelectorAll('*')].flatMap((el) => {
        const { boxShadow, backgroundColor } = getComputedStyle(el);
        const overlay = getComputedStyle(el, '::after');
        const lightOver = overlay.content !== 'none' && Number(overlay.opacity) > 0 && overlay.boxShadow === lit;
        return boxShadow === lit || backgroundColor === hover || lightOver ? [`${el.localName} (${el.getAttribute('class') ?? ''})`] : [];
      });

    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      await page.viewport(size.width, size.height);
      const screen = await render(
        <>
          <div style={{ height: '150vh' }} />
          <ArchitectureFigure compact={compact} />
          <div style={{ height: '150vh' }} />
        </>,
      );
      const figure = screen.container.querySelector('figure');
      if (!figure) throw new Error('no figure');
      await frames();
      expect(figure.getBoundingClientRect().top, `${size.width} wide`).toBeGreaterThan(window.innerHeight);
      for (const where of ['below the fold', 'in view']) {
        if (where === 'in view') {
          figure.scrollIntoView({ block: 'center' });
          await frames();
        }
        expect(figure.hasAttribute('data-play'), `${size.width} wide, ${where}`).toBe(false);
        expect(motionUnder(figure), `${size.width} wide, ${where}`).toEqual([]);
        expect(litUnder(figure), `${size.width} wide, ${where}`).toEqual([]);
      }
      await screen.unmount();
      window.scrollTo(0, 0);
    }
  });

  it('architecture_outcomes_have_words', async () => {
    for (const compact of [false, true]) {
      const screen = await render(<ArchitectureFigure compact={compact} />);
      // Each outcome is a pill: a status dot beside its word, so its status never rests on color alone.
      const outcomes = [...screen.container.querySelectorAll('[data-diagram] .cd-pill')].map((pill) => {
        const dots = [...pill.querySelectorAll('.cd-status-dot')];
        const tone = /cd-status-dot--(\w+)/.exec(dots[0]?.className ?? '')?.[1];
        return `${dots.length === 1 ? tone : `${dots.length} dots`}: ${pill.textContent?.trim()}`;
      });
      expect(outcomes, `compact ${compact}`).toEqual([
        'handled: Runs',
        'held: Owner decides',
        'refused: Refused',
        'handled: Shown',
        'held: Handed off',
      ]);
      for (const dot of screen.container.querySelectorAll('[data-diagram] .cd-status-dot')) {
        expect(dot.getAttribute('aria-hidden')).toBe('true');
      }
      await screen.unmount();
    }
  });
});

describe('ReadinessScale', () => {
  it('readiness_marks_each_rating', async () => {
    for (const compact of [false, true]) {
      const screen = await render(<ReadinessScale table={READINESS} compact={compact} />);
      const figure = screen.container.querySelector('figure');

      // The scale's four steps, in order.
      const steps = [...(figure?.querySelectorAll('[data-steps] > *') ?? [])].map((step) => step.textContent);
      expect(steps, `compact ${compact}`).toEqual(['Lagging', 'Early', 'Gated', 'Near']);

      // Each axis marks its rating on the scale, and says it.
      const axes = [...(figure?.querySelectorAll('[data-axis]') ?? [])].map((axis) => {
        const stops = [...axis.querySelectorAll('[data-stop]')];
        const marked = stops.flatMap((stop, i) => (stop.hasAttribute('data-on') ? [steps[i]] : []));
        return {
          name: axis.querySelector('[data-axis-name]')?.textContent,
          stops: stops.length,
          marked,
          rating: axis.querySelector('[data-rating]')?.textContent,
        };
      });
      expect(axes).toEqual([
        { name: 'Apply policies', stops: 4, marked: ['Near'], rating: 'Near' },
        { name: 'Resist the visitor', stops: 4, marked: ['Lagging'], rating: 'Lagging' },
        { name: 'Negotiate', stops: 4, marked: ['Early'], rating: 'Early' },
        { name: 'Run unattended', stops: 4, marked: ['Gated'], rating: 'Gated' },
        { name: 'Visiting agents', stops: 4, marked: ['Early'], rating: 'Early' },
      ]);

      // The marked stop is the large, filled one.
      for (const stop of figure?.querySelectorAll('[data-stop][data-on]') ?? []) {
        expect(getComputedStyle(stop).backgroundColor).toBe(tokenColor('--text-primary'));
      }

      // Then its evidence, and what to watch for under the table's own heading.
      const first = figure?.querySelector('[data-axis]');
      expect(first?.querySelector('[data-evidence]')?.textContent).toBe(
        'Claude’s τ³-Banking pass^1 rose from 24.7% to 48.7% in eight months',
      );
      expect(first?.querySelector('[data-evidence] a')?.getAttribute('href')).toBe('https://taubench.com/leaderboard');
      expect(
        [...(first?.querySelectorAll('[data-watch] > *') ?? [])].map((part) => part.textContent),
      ).toEqual(['Watch for', 'Opus 5.5’s score; a flat one would mean lagging']);
      await screen.unmount();
    }
  });

  it('readiness_rejects_an_unknown_rating', () => {
    const text = (words: string) => [{ kind: 'text' as const, text: words }];
    const rated = (rating: string): Table => ({
      kind: 'table',
      head: ['Axis', 'Readiness', 'Evidence', 'Watch for'].map(text),
      rows: [['Apply policies', rating, 'A trend', 'A score'].map(text)],
    });
    expect(readinessRows(rated('Near')).map((row) => row.rating)).toEqual(['Near']);
    for (const rating of ['Soon', 'near', 'Near ', '']) {
      expect(() => readinessRows(rated(rating)), JSON.stringify(rating)).toThrow(/not one of Lagging, Early, Gated, Near/);
    }
    // A rating with markup isn't a plain step either.
    const bold = rated('Near');
    bold.rows[0]![1] = [{ kind: 'strong', children: text('Near') }];
    expect(() => readinessRows(bold)).toThrow(/not one of/);
    // Nor is a table of other columns.
    expect(() => readinessRows({ ...rated('Near'), head: rated('Near').head.slice(0, 3) })).toThrow(/columns/);
  });
});

describe('MeasuresTable', () => {
  const measures = tableOf(ABOUT_DOCUMENTS.proposal.blocks, null);
  const MEASURES = measures.rows.map((row) => inlineText(row[0] ?? []));

  it('measures_table_reads_as_a_list_on_a_phone', async () => {
    // On a desktop, a table: its header, then a row per measure led by the measure's name.
    const wide = await render(<MeasuresTable table={measures} />);
    const table = wide.container.querySelector('table');
    expect([...(table?.querySelectorAll('thead th[scope="col"]') ?? [])].map((th) => th.textContent)).toEqual([
      'Measure',
      'What it shows',
      'Prototype',
    ]);
    expect([...(table?.querySelectorAll('tbody th[scope="row"]') ?? [])].map((th) => th.textContent)).toEqual(MEASURES);
    expect(wide.container.querySelector('dl')).toBeNull();
    await wide.unmount();

    // On a phone, a list: each measure a term, what it shows, then each later column under its heading.
    await page.viewport(PHONE.width, PHONE.height);
    const narrow = await render(<MeasuresTable table={measures} compact />);
    expect(narrow.container.querySelector('table')).toBeNull();
    const items = [...narrow.container.querySelectorAll('dl > div')];
    expect(items.map((item) => item.querySelector('dt')?.textContent)).toEqual(MEASURES);
    for (const item of items) {
      const [shows, prototype, ...more] = [...item.querySelectorAll('dd')];
      expect(more).toEqual([]);
      expect(shows?.querySelector('[data-label]')).toBeNull();
      expect(prototype?.querySelector('[data-label]')?.textContent).toBe('Prototype');
    }
    // Live placeholders follow the document, including none once its measurements are filled.
    const pills = [...narrow.container.querySelectorAll('dl .cd-pill')];
    expect(pills.map((pill) => pill.textContent)).toEqual(placeholderTexts([measures]));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE.width);
    for (const el of narrow.container.querySelectorAll('dl *')) {
      expect(el.getBoundingClientRect().right, el.textContent ?? '').toBeLessThanOrEqual(PHONE.width);
    }
  });

  it('measure_placeholders_render_until_filled', async () => {
    const unfilled: Table = {
      kind: 'table',
      head: measures.head,
      rows: [
        [[{ kind: 'text', text: 'Violations' }], [{ kind: 'text', text: 'Actions outside the rules' }],
          [{ kind: 'placeholder', text: 'measured: violations' }, { kind: 'text', text: '; the gate requires 0.' }]],
        [[{ kind: 'text', text: 'Cost' }], [{ kind: 'text', text: 'Model cost' }],
          [{ kind: 'placeholder', text: 'measured: cost' }]],
      ],
    };
    const values = ['0', '$0.20'];
    const filled: Table = {
      ...unfilled,
      rows: unfilled.rows.map((row, r) => row.map((cell) => cell.map((inline): Inline =>
        inline.kind === 'placeholder' ? { kind: 'text', text: values[r] ?? '' } : inline))),
    };
    for (const [size, compact] of [[DESKTOP, false], [PHONE, true]] as const) {
      await page.viewport(size.width, size.height);
      const pending = await render(<MeasuresTable table={unfilled} compact={compact} />);
      const pills = [...pending.container.querySelectorAll('.cd-pill')];
      expect(pills.map((pill) => pill.textContent)).toEqual(['measured: violations', 'measured: cost']);
      const glued = pills[0]?.closest('.cd-about-nowrap');
      expect(glued?.textContent).toBe('measured: violations;');
      expect(getComputedStyle(glued ?? document.body).whiteSpace).toBe('nowrap');
      expect(pills[1]?.closest('.cd-about-nowrap')).toBeNull();
      await pending.unmount();

      const measured = await render(<MeasuresTable table={filled} compact={compact} />);
      expect(measured.container.querySelectorAll('.cd-pill')).toHaveLength(0);
      expect(measured.container.textContent).toContain('0; the gate requires 0.');
      expect(measured.container.textContent).toContain('$0.20');
      await measured.unmount();
    }
  });
});

/** The reading pages' ground: the About set's paper, the app's tokens pointed at it (paper.css). */
const PAPER = 'cd-about-paper cd-about-paper--app';

describe('the figures together', () => {
  it('figures_pass_axe', async () => {
    const readiness = READINESS;
    const measures = tableOf(ABOUT_DOCUMENTS.proposal.blocks, null);
    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      await page.viewport(size.width, size.height);
      // On the paper the reading pages draw them on, so axe reads their text against it.
      const screen = await render(
        <main className={PAPER}>
          <ArchitectureFigure compact={compact} />
          <Tau3Chart compact={compact} />
          <ReadinessScale table={readiness} compact={compact} />
          <MeasuresTable table={measures} compact={compact} />
        </main>,
      );
      assertCleanCopy(screen.container);
      const results = await axe.run(screen.container, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
      expect(results.passes.map((rule) => rule.id)).toEqual(expect.arrayContaining(['color-contrast', 'svg-img-alt']));
      const violations = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${v.help} at ${n.target.join(' ')}`));
      expect(violations, `${size.width} wide`).toEqual([]);
      // Nothing runs past the window's width.
      expect(document.documentElement.scrollWidth, `${size.width} wide`).toBeLessThanOrEqual(size.width);
      await screen.unmount();
    }
  });
});

describe('the figures on paper', () => {
  it('figure_marks_hold_on_paper', async () => {
    // On the reading pages' paper, every mark a reader needs to read a figure holds 3:1 against what it is drawn
    // on, and the charts' own words (SVG text, which axe doesn't read) hold 4.5:1; so does a focus ring. The
    // status dots echo the word in their pill, and the hairlines, gridlines and track are structure, so neither
    // is held to it.
    const measures = tableOf(ABOUT_DOCUMENTS.proposal.blocks, null);
    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      const where = `${size.width} wide`;
      await page.viewport(size.width, size.height);
      const screen = await render(
        <main className={PAPER}>
          <ArchitectureFigure compact={compact} />
          <Tau3Chart compact={compact} />
          <ReadinessScale table={READINESS} compact={compact} />
          <MeasuresTable table={measures} compact={compact} />
        </main>,
      );
      const root = screen.container.querySelector('main') as HTMLElement;
      const paper = getComputedStyle(root).backgroundColor;
      expect(paper, where).toBe('rgb(244, 242, 236)');
      const ground = (el: Element) => {
        const frame = el.closest('.cd-about-frame');
        return frame ? getComputedStyle(frame).backgroundColor : paper;
      };
      const all = (selector: string) => {
        const found = [...root.querySelectorAll(selector)];
        expect(found, `${where}: ${selector}`).not.toEqual([]);
        return found;
      };
      const marks: [string, (el: Element) => string][] = [
        // The chart: the releases, the top score's ring, Opus 5's ring, the fit, the bar, the prediction date's
        // rule, and the key's dot and dash.
        ['[data-point="claude"]', (el) => getComputedStyle(el).fill],
        ['[data-point="top"]', (el) => getComputedStyle(el).stroke],
        ['[data-ring]', (el) => getComputedStyle(el).stroke],
        ['[data-tau3-part="fit"]', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__bar', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__rule', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__key-dot', (el) => getComputedStyle(el).backgroundColor],
        ['.cd-about-chart__key-dash', (el) => getComputedStyle(el).borderTopColor],
        // The architecture: the arrows between its parts and the kernel's outline.
        ['.cd-about-arch__connector', (el) => getComputedStyle(el).stroke],
        ['.cd-about-arch__kernel', (el) => /rgba?\([^)]*\)/.exec(getComputedStyle(el).boxShadow)?.[0] ?? ''],
        // The readiness scale: each axis's four steps and its rating.
        ['.cd-about-readiness__stop:not(.cd-about-readiness__stop--on)', (el) => /rgba?\([^)]*\)/.exec(getComputedStyle(el).boxShadow)?.[0] ?? ''],
        ['.cd-about-readiness__stop--on', (el) => getComputedStyle(el).backgroundColor],
      ];
      for (const [selector, color] of marks) {
        for (const el of all(selector)) {
          expect(contrastRatio(color(el), ground(el)), `${where}: ${selector}`).toBeGreaterThanOrEqual(3);
        }
      }
      for (const text of all('svg text')) {
        expect(contrastRatio(getComputedStyle(text).fill, ground(text)), `${where}: ${text.textContent}`).toBeGreaterThanOrEqual(4.5);
      }
      // A focus ring, in the paper's link color, on the paper and on a figure's card.
      const ring = tokenColor('--accent-blue', root);
      expect(ring, where).toBe('rgb(45, 91, 138)');
      for (const on of [paper, ground(all('.cd-about-frame')[0] as Element)]) expect(contrastRatio(ring, on), where).toBeGreaterThanOrEqual(3);
      await screen.unmount();
    }
  });
});
