/**
 * The About pages' figures in a real browser: what each one draws, the words it says, its text equivalent,
 * and that it passes the copy check and axe at the desktop and phone sizes. Expected words and values are
 * written out here, never read from the components.
 */
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { contrastRatio } from '../ds/contrast.ts';
import { assertCleanCopy } from '../ds/test/copy.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { placeholderTexts } from '../test/about.ts';
import { AXE_TAGS, tokenColor } from '../test/screen.ts';
import { ABOUT_DOCUMENTS, inlineText, type Block, type Inline } from './documents.ts';
import { ARCHITECTURE_LABELS, ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { LaunchFilm } from './figures/LaunchFilm.tsx';
import { MeasuresTable } from './figures/MeasuresTable.tsx';
import { ReadinessScale, readinessRows } from './figures/ReadinessScale.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { forgetPlayedFigures } from './figures/usePlayOnce.ts';

// The reading page's stylesheets: the paper, and the top bar's, which sets the page's side gutter.
import './AboutBar.css';
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
 * 48.7%). `y(score)` is where a score sits; `days(x, iso)` is how many days `x` lies past the day `iso`; `x(iso)` is
 * where the day `iso` sits.
 */
function chartScales(sonnet: Element | undefined, opus5: Element | undefined) {
  const at = (el: Element | undefined, name: 'cx' | 'cy') => Number(el?.getAttribute(name));
  const first = { t: Date.parse('2025-09-29T00:00:00Z'), x: at(sonnet, 'cx'), score: 25.3, y: at(sonnet, 'cy') };
  const last = { t: Date.parse('2026-07-24T00:00:00Z'), x: at(opus5, 'cx'), score: 48.7, y: at(opus5, 'cy') };
  const perDay = (last.x - first.x) / ((last.t - first.t) / DAY);
  return {
    y: (score: number) => first.y + ((score - first.score) / (last.score - first.score)) * (last.y - first.y),
    days: (x: number, iso: string) => (x - first.x) / perDay - (Date.parse(`${iso}T00:00:00Z`) - first.t) / DAY,
    x: (iso: string) => first.x + ((Date.parse(`${iso}T00:00:00Z`) - first.t) / DAY) * perDay,
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

/** Text under `root` that a person reads, keeping label lines whole across inline emphasis. */
function readTexts(root: Element): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[aria-hidden="true"]') || (node.textContent ?? '').trim() === ''
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const texts: string[] = [];
  const lines = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const line = node.parentElement?.closest('.cd-about-arch__line');
    if (line && lines.has(line)) continue;
    if (line) lines.add(line);
    texts.push(((line ?? node).textContent ?? '').trim());
  }
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
  'Cedar rules from the owner’s cards',
  'A Sonnet review can only narrow',
  'Runs',
  'Owner decides',
  'Refused',
  'Check reply',
  'Prices, dates and discounts only in typed cards',
  'Sonnet and Jev can only add blocks',
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

/** The ten Claude points, by release, each with its score and its board, then the top score, another lab's. */
const CLAUDE_POINTS = [
  'Claude Sonnet 4.5, 25.3% on Sierra',
  'Claude Opus 4.5, 24.7% on Sierra',
  'Claude Opus 4.6, 27.3% on Sierra',
  'Claude Opus 4.7, 40.2% on Sierra',
  'Claude Opus 4.8, 39.7% on Sierra',
  'Claude Fable 5, 39.7% on Sierra',
  'Claude Sonnet 5, 37.3% on Artificial Analysis',
  'Claude Opus 5, 48.7% on Sierra',
  'Claude Fable 5.1, 47.2% on Artificial Analysis',
  'Claude Opus 5.5, 56.0% on Fireworks',
];
const TOP_POINT = 'Gemini 4 Argon, 58.2% on Fireworks';

/** The labelled scores, by release: each its model and score, then its board, as the board draws them. */
const POINT_LABELS = [
  ['Sonnet 5, 37.3%', 'AA'],
  ['Opus 5, 48.7%', 'Sierra'],
  ['Fable 5.1, 47.2%', 'AA'],
  ['Opus 5.5, 56.0%', 'Fireworks'],
  ['Gemini 4 Argon, 58.2%', 'Fireworks'],
];

/** The quarters on the time axis, from Q3 2025 to Q4 2027, the prediction's: each one's first day and its name. */
const QUARTERS = [
  ['2025-07-01', 'Q3'],
  ['2025-10-01', 'Q4'],
  ['2026-01-01', 'Q1'],
  ['2026-04-01', 'Q2'],
  ['2026-07-01', 'Q3'],
  ['2026-10-01', 'Q4'],
  ['2027-01-01', 'Q1'],
  ['2027-04-01', 'Q2'],
  ['2027-07-01', 'Q3'],
  ['2027-10-01', 'Q4'],
  ['2028-01-01', ''],
] as const;

/** The chart's caption, after "Figure 1". */
const CAPTION =
  'Each dot is one model’s score. Seven of Claude’s scores, up to Opus 5, are from Sierra’s board; Sonnet 5 and ' +
  'Fable 5.1 are from Artificial Analysis (AA), and Opus 5.5 and Gemini 4 Argon from Fireworks. The line is a ' +
  'straight-line fit in log-odds through all ten Claude scores, dashed where it runs ahead of today. The band runs ' +
  'from where the Opus scores alone reach 80% to where all ten do. The boards’ setups differ, so scores from ' +
  'different boards are only roughly comparable.';

describe('the about project', () => {
  it('about_project_runs_with_reduced_motion', () => {
    // How the figures play is checked in the about-motion project's files, which this project leaves out.
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  });
});

describe('Tau3Chart', () => {
  it('chart_shows_the_boards', async () => {
    const primary = tokenColor('--text-primary');
    const secondary = tokenColor('--text-secondary');
    const panel = tokenColor('--bg-panel');
    const texts = (els: Iterable<Element>) => [...els].map((el) => el.textContent);

    for (const compact of [false, true]) {
      const where = `compact ${compact}`;
      const screen = await render(<Tau3Chart compact={compact} />);
      const svg = screen.container.querySelector('svg[role="img"]');
      expect(svg, where).not.toBeNull();
      if (!svg) continue;

      // Its title, the line under it, and the key.
      const head = screen.container.querySelector('.cd-about-chart__head');
      expect(texts(head?.querySelectorAll(':scope > p') ?? []), where).toEqual([
        'Claude’s τ³-Banking score, and when the trend reaches 80%',
        compact
          ? 'Bank customer-service tasks done right on the first try'
          : 'The share of a bank’s customer-service tasks each model gets right on the first try, by its release date',
        compact ? 'ClaudeAnother labTrendReaches 80%' : 'ClaudeAnother labTrend through Claude’s scoresWhen the trend reaches 80%',
      ]);
      expect(texts(head?.querySelectorAll('.cd-about-chart__key-item') ?? []), where).toEqual(
        compact
          ? ['Claude', 'Another lab', 'Trend', 'Reaches 80%']
          : ['Claude', 'Another lab', 'Trend through Claude’s scores', 'When the trend reaches 80%'],
      );

      // Ten filled points in primary ink, each with its score and board in its title.
      const filled = [...svg.querySelectorAll('[data-point="claude"]')];
      expect(titles(filled), where).toEqual(CLAUDE_POINTS);
      for (const point of filled) expect(getComputedStyle(point).fill).toBe(primary);

      // One hollow point in secondary ink: the top score on any board, another lab's.
      const hollow = [...svg.querySelectorAll('[data-point="top"]')];
      expect(titles(hollow), where).toEqual([TOP_POINT]);
      for (const point of hollow) {
        expect(getComputedStyle(point).fill).toBe(panel);
        expect(getComputedStyle(point).stroke).toBe(secondary);
      }

      // The latest Claude point, Opus 5.5, ringed.
      const ring = svg.querySelector('[data-ring]');
      const opus55 = filled.at(-1);
      expect(ring?.getAttribute('cx'), where).toBe(opus55?.getAttribute('cx'));
      expect(ring?.getAttribute('cy'), where).toBe(opus55?.getAttribute('cy'));

      // Each labelled score names its model, its score and its board; Sierra's early run shares one label on a laptop.
      const labels = [...svg.querySelectorAll('[data-point-label]')].map((label) => texts(label.querySelectorAll('text')));
      expect(labels, where).toEqual(POINT_LABELS);
      expect(texts(svg.querySelectorAll('[data-point-note]')), where).toEqual(compact ? [] : ['Sonnet 4.5 to Fable 5: Sierra']);
      // The rest are that run: Sierra's first six.
      const labelled = new Set(POINT_LABELS.map(([name]) => name?.split(',')[0]));
      const rest = CLAUDE_POINTS.filter((title) => !labelled.has(title.replace(/^Claude /, '').split(',')[0]));
      expect(rest, where).toEqual(CLAUDE_POINTS.slice(0, 6));
      for (const title of rest) expect(title, where).toMatch(/ on Sierra$/);

      // The scales, from two of its own points: Sonnet 4.5 (Sep 29, 2025, 25.3%) and Opus 5 (Jul 24, 2026, 48.7%).
      const opus5 = filled.find((point) => point.querySelector('title')?.textContent?.startsWith('Claude Opus 5,'));
      const scales = chartScales(filled[0], opus5);
      const near = (x: number, iso: string, days = 1.5) => expect(Math.abs(scales.days(x, iso)), `${where}: ${iso}`).toBeLessThan(days);

      // The time axis in quarters: a tick at each quarter's start, its name halfway along it, the years under them.
      const ticks = [...svg.querySelectorAll('[data-tau3-part="tick"]')].map((tick) => Number(tick.getAttribute('x1')));
      expect(ticks, where).toHaveLength(QUARTERS.length);
      QUARTERS.forEach(([iso], i) => near(ticks[i] ?? 0, iso));
      const tickLabels = [...svg.querySelectorAll('[data-tau3-part="tick-label"]')];
      expect(texts(tickLabels), where).toEqual([...QUARTERS.slice(0, -1).map(([, name]) => name), '2025', '2026', '2027']);
      QUARTERS.slice(0, -1).forEach(([iso], i) => {
        const next = QUARTERS[i + 1]?.[0] ?? iso;
        const middle = (scales.x(iso) + scales.x(next)) / 2;
        expect(Math.abs(Number(tickLabels[i]?.getAttribute('x')) - middle), `${where}: ${iso}'s name`).toBeLessThan(1);
      });
      // The prediction's quarter is named in primary ink, the others in secondary.
      expect(tickLabels.slice(0, 10).map((label) => getComputedStyle(label).fill === primary), where).toEqual([
        ...Array<boolean>(9).fill(false),
        true,
      ]);

      // Today, a vertical rule on the day the boards were read.
      const today = svg.querySelector('[data-today]');
      near(Number(today?.getAttribute('x1')), '2026-11-02');
      expect(today?.getAttribute('x2'), where).toBe(today?.getAttribute('x1'));
      expect(texts(svg.querySelectorAll('[data-tau3-part="today-label"]')), where).toEqual(['Today']);

      // The bar, dotted at 80%.
      expect(svg.querySelectorAll('[data-bar]'), where).toHaveLength(1);
      const bar = Number(svg.querySelector('[data-bar]')?.getAttribute('y1'));
      expect(Math.abs(bar - scales.y(80)), `${where}: the bar's y`).toBeLessThan(0.5);
      expect(getComputedStyle(svg.querySelector('[data-bar]') as Element).strokeDasharray, where).not.toBe('none');
      expect(texts(svg.querySelectorAll('[data-tau3-part="bar-label"]')), where).toEqual(['The bar: 80%']);

      // The band, from where the Opus fit reaches 80% (May 31, 2027) to where the fit through all ten does (Oct 3,
      // 2027), named in quarters.
      expect(svg.querySelectorAll('[data-band]'), where).toHaveLength(1);
      const band = svg.querySelector('[data-band]');
      const left = Number(band?.getAttribute('x'));
      const right = left + Number(band?.getAttribute('width'));
      near(left, '2027-05-31');
      near(right, '2027-10-03');
      expect(texts(svg.querySelectorAll('[data-tau3-part="band-label"]')), where).toEqual([
        compact ? 'Reaches 80%' : 'Trend reaches 80%',
        'Q2 to early Q4 2027',
      ]);

      // The prediction: a bracket over Q4 2027.
      const bracket = (svg.querySelector('[data-bracket]')?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const xs = [bracket[0] ?? 0, bracket[3] ?? 0];
      near(Math.min(...xs), '2027-10-01');
      near(Math.max(...xs), '2028-01-01');
      expect(texts(svg.querySelectorAll('[data-tau3-part="prediction-date"]')), where).toEqual([
        compact ? 'By Q4 2027' : 'Prediction: by Q4 2027',
      ]);

      // The trend through all ten: solid from the first score to today, then dashed from today to the bar, which it
      // reaches near Oct 3, 2027.
      const line = (selector: string) =>
        (svg.querySelector(selector)?.getAttribute('points') ?? '').split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);
      const solid = line('[data-trend]');
      const fit = line('[data-fit]');
      expect(svg.querySelectorAll('[data-trend]'), where).toHaveLength(1);
      expect(svg.querySelectorAll('[data-fit]'), where).toHaveLength(1);
      near(solid[0]?.[0] ?? 0, '2025-09-29');
      near(solid.at(-1)?.[0] ?? 0, '2026-11-02');
      expect(fit[0], where).toEqual(solid.at(-1));
      expect(getComputedStyle(svg.querySelector('[data-trend]') as Element).strokeDasharray, where).toBe('none');
      expect(svg.querySelector('[data-fit]')?.getAttribute('stroke-dasharray'), where).toBeTruthy();
      const crossing = crossesAt(fit, bar + 0.01);
      expect(crossing, `${where}: the fit reaches the bar`).not.toBeNull();
      near(crossing ?? 0, '2027-10-03', 3);
      expect(Math.abs((fit.at(-1)?.[1] ?? 0) - bar), `${where}: the dashed line ends at the bar`).toBeLessThan(0.5);
      near(fit.at(-1)?.[0] ?? 0, '2027-10-03');

      // Under it, "Figure 1" and the caption.
      const caption = screen.container.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim();
      expect(caption, where).toBe(`Figure 1 ${CAPTION}`);
      await screen.unmount();
    }
  });

  it('chart_labels_stay_inside_its_card', async () => {
    // At the laptop's column and on a phone, every word the chart draws sits inside its card, and no two labels
    // overlap.
    await loadWebFonts();
    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      const where = `${size.width} wide`;
      await page.viewport(size.width, size.height);
      const screen = await render(
        <main className={PAPER} style={{ width: compact ? '350px' : '648px' }}>
          <Tau3Chart compact={compact} />
        </main>,
      );
      const frame = screen.container.querySelector('.cd-about-frame') as Element;
      const edge = frame.getBoundingClientRect();
      const words = [...frame.querySelectorAll('svg text')];
      for (const word of words) {
        const box = word.getBoundingClientRect();
        const inside = box.left >= edge.left && box.right <= edge.right && box.top >= edge.top && box.bottom <= edge.bottom;
        expect(inside, `${where}: ${word.textContent}`).toBe(true);
      }
      // A label's two lines, and the band's, are set 15 px apart, a little closer than their boxes are tall.
      const unit = (el: Element) => el.closest('[data-point-label]') ?? (el.getAttribute('data-tau3-part') === 'band-label' ? 'band' : el);
      const overlaps: string[] = [];
      words.forEach((a, i) => {
        for (const b of words.slice(i + 1)) {
          if (unit(a) === unit(b)) continue;
          const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
          if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) {
            overlaps.push(`${a.textContent} / ${b.textContent}`);
          }
        }
      });
      expect(overlaps, where).toEqual([]);
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

      // A table of all eleven points: model, release month, score and board.
      const rows = [...description.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => cell.textContent),
      );
      expect([...description.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
        'Model',
        'Released',
        'Score',
        'Board',
      ]);
      expect(rows).toEqual([
        ['Claude Sonnet 4.5', 'September 2025', '25.3%', 'Sierra'],
        ['Claude Opus 4.5', 'November 2025', '24.7%', 'Sierra'],
        ['Claude Opus 4.6', 'February 2026', '27.3%', 'Sierra'],
        ['Claude Opus 4.7', 'April 2026', '40.2%', 'Sierra'],
        ['Claude Opus 4.8', 'May 2026', '39.7%', 'Sierra'],
        ['Claude Fable 5', 'June 2026', '39.7%', 'Sierra'],
        ['Claude Sonnet 5', 'June 2026', '37.3%', 'Artificial Analysis'],
        ['Claude Opus 5', 'July 2026', '48.7%', 'Sierra'],
        ['Claude Fable 5.1', 'September 2026', '47.2%', 'Artificial Analysis'],
        ['Claude Opus 5.5', 'September 2026', '56.0%', 'Fireworks'],
        ['Gemini 4 Argon, another lab', 'October 2026', '58.2%', 'Fireworks'],
      ]);

      // And what the line, the band and the prediction show, in quarters.
      expect(description.querySelector('p')?.textContent).toBe(
        'The line, a straight-line fit in log-odds through all ten Claude scores, is solid up to today, Q4 2026, and ' +
          'dashed after; it reaches 80% early in Q4 2027. The band runs from Q2 2027, where the fit through the Opus ' +
          'scores alone reaches 80%, to early Q4 2027. The prediction is by Q4 2027.',
      );
      await screen.unmount();
    }
  });
});

describe('ArchitectureFigure', () => {
  it('architecture_technology_names_stand_out_in_both_layouts', async () => {
    for (const [size, compact] of [[DESKTOP, false], [PHONE, true]] as const) {
      await page.viewport(size.width, size.height);
      const screen = await render(<ArchitectureFigure compact={compact} />);
      const names = [...screen.container.querySelectorAll('.cd-about-arch__tech')];
      expect(names.map((name) => [name.textContent, name.parentElement?.textContent]), `${size.width} wide`).toEqual([
        ['Cedar', 'Cedar rules from the owner’s cards'],
        ['Sonnet', 'A Sonnet review can only narrow'],
        ['Sonnet', 'Sonnet and Jev can only add blocks'],
        ['Jev', 'Sonnet and Jev can only add blocks'],
      ]);
      for (const name of names) {
        const style = getComputedStyle(name);
        const line = getComputedStyle(name.parentElement!);
        expect(Number(style.fontWeight), `${size.width}: ${name.textContent}`).toBeGreaterThan(Number(line.fontWeight));
        expect(style.color).toBe(tokenColor('--text-primary'));
        expect(line.color).toBe(tokenColor('--text-secondary'));
      }
      await screen.unmount();
    }
  });

  it('architecture_check_heights_match_the_reviewed_figure', async () => {
    await loadWebFonts();
    // Measured on /about/proposal at d14424d6b, before emphasizing the technology names (124 px each at 1440,
    // 120 at 390), then at the raised type scale, where the name and every caption line is a pixel taller. The two
    // checks are stacked, not a row, so on a phone each box keeps its own height: Check reply's first line takes
    // two lines there. Drawn where the proposal drew it until the launch film took its place: the reading page's
    // hero figure, at its width.
    for (const [size, heights] of [[DESKTOP, [129, 129]], [PHONE, [123, 141]]] as const) {
      await page.viewport(size.width, size.height);
      const compact = size === PHONE;
      const screen = await render(
        <div className={`${PAPER} cd-about-set cd-about-page${compact ? ' cd-about-page--compact' : ''}`}>
          <main className="cd-about-main">
            <div className="cd-about-hero">
              <div className="cd-about-hero__figure">
                <ArchitectureFigure compact={compact} />
              </div>
            </div>
          </main>
        </div>,
      );
      const checks = screen.container.querySelector('.cd-about-arch__checks') as HTMLElement;
      expect(getComputedStyle(checks).flexDirection, `${size.width} wide: checks stack`).toBe('column');
      const boxes = [...screen.container.querySelectorAll('.cd-about-arch__check > .cd-about-arch__box')];
      expect(boxes.map((box) => box.getBoundingClientRect().height), `${size.width} wide`).toEqual(heights);
      await screen.unmount();
    }
  });

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

  it('architecture_checks_say_both_tiers_in_their_box', async () => {
    // Each of the kernel's checks names itself, then says its tier in code and what the models may do, each line
    // whole inside its box at the desktop and phone sizes: nothing runs past an edge or is cut off.
    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      const where = `${size.width} wide`;
      await page.viewport(size.width, size.height);
      const screen = await render(<ArchitectureFigure compact={compact} />);
      const boxes = [...screen.container.querySelectorAll('.cd-about-arch__check > .cd-about-arch__box')];
      const lines = (box: Element) => [...box.querySelectorAll(':scope > span')];
      expect(
        boxes.map((box) => lines(box).map((line) => line.textContent)),
        where,
      ).toEqual([
        ['Decide', 'Cedar rules from the owner’s cards', 'A Sonnet review can only narrow'],
        ['Check reply', 'Prices, dates and discounts only in typed cards', 'Sonnet and Jev can only add blocks'],
      ]);
      for (const text of [
        'Cedar rules from the owner’s cards',
        'A Sonnet review can only narrow',
        'Sonnet and Jev can only add blocks',
      ]) {
        await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
      }
      for (const box of boxes) {
        const edge = box.getBoundingClientRect();
        expect(box.scrollWidth, `${where}: ${box.textContent}`).toBeLessThanOrEqual(box.clientWidth);
        for (const line of lines(box)) {
          const { left, right, top, bottom } = line.getBoundingClientRect();
          const inside = left >= edge.left && right <= edge.right && top >= edge.top && bottom <= edge.bottom;
          expect(inside, `${where}: ${line.textContent}`).toBe(true);
        }
      }
      await screen.unmount();
    }
  });
});

/** The launch film's words: its name, as a screen reader reads the player, and what it shows, under it. */
const FILM_NAME = 'Claude Desk launch film, 2 minutes';
const FILM_SHOWS =
  'Mike’s Desk quotes and books a repair at 11:46 pm, asks Mike before an emergency visit, takes a booking and ' +
  'deposit from a customer’s AI assistant within the limit they signed, and won’t be talked into a refund. Music, no voice.';

describe('LaunchFilm', () => {
  it('film_waits_for_a_reader_to_play_it', async () => {
    // A native player with the film's poster and its controls, inline on a phone, reading only the film's length and
    // size until it is played. It never starts by itself: the film's music carries it, so a reader starts it. One
    // file serves every width.
    for (const compact of [false, true]) {
      const where = `compact ${compact}`;
      const screen = await render(<LaunchFilm compact={compact} />);
      const videos = [...screen.container.querySelectorAll('video')];
      expect(videos, where).toHaveLength(1);
      const video = videos[0] as HTMLVideoElement;
      expect(video.getAttribute('poster'), where).toMatch(/\/launch-film-poster(?:-[\w-]+)?\.jpg$/);
      expect(video.controls, where).toBe(true);
      expect(video.hasAttribute('playsinline'), where).toBe(true);
      expect(video.getAttribute('preload'), where).toBe('metadata');
      expect([video.autoplay, video.hasAttribute('autoplay'), video.muted, video.loop], where).toEqual([false, false, false, false]);
      const sources = [...video.querySelectorAll('source')];
      expect(sources.map((source) => [source.getAttribute('type'), source.hasAttribute('media')]), where).toEqual([['video/mp4', false]]);
      expect(sources[0]?.getAttribute('src'), where).toMatch(/\/launch-film-1080(?:-[\w-]+)?\.mp4$/);
      // Once the page has settled, still waiting at the start.
      await frames(10);
      expect([video.paused, video.currentTime], where).toEqual([true, 0]);
      await screen.unmount();
    }
  });

  it('film_has_its_name_and_says_what_it_shows', async () => {
    // The film has music and no voice, so the words under it say what it shows, and the player is named and
    // described by them. On the reading pages' paper it passes the copy check and axe.
    for (const [size, compact] of [
      [DESKTOP, false],
      [PHONE, true],
    ] as const) {
      const where = `${size.width} wide`;
      await page.viewport(size.width, size.height);
      const screen = await render(
        <main className={PAPER}>
          <LaunchFilm compact={compact} />
        </main>,
      );
      const video = screen.getByLabelText(FILM_NAME, { exact: true });
      await expect.element(video, { message: where }).toBeInTheDocument();
      const player = video.element() as HTMLVideoElement;
      expect(player.localName, where).toBe('video');
      const described = document.getElementById(player.getAttribute('aria-describedby') ?? '');
      expect(described?.textContent?.replace(/\s+/g, ' ').trim(), where).toBe(FILM_SHOWS);
      // The words are the figure's caption, under the player, where everyone can read them.
      const figure = player.closest('figure') as HTMLElement;
      const caption = figure.querySelector('figcaption') as HTMLElement;
      expect(caption.contains(described), where).toBe(true);
      expect(caption.checkVisibility(), where).toBe(true);
      expect(caption.getBoundingClientRect().top, where).toBeGreaterThanOrEqual(player.getBoundingClientRect().bottom);
      expect(getComputedStyle(caption).color, where).toBe(tokenColor('--text-secondary', caption));

      assertCleanCopy(screen.container);
      const results = await axe.run(screen.container, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
      const violations = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${v.help} at ${n.target.join(' ')}`));
      expect(violations, where).toEqual([]);
      expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(size.width);
      await screen.unmount();
    }
  });

  it('film_draws_keyboard_focus_on_its_own_edge', async () => {
    // Keyboard focus on the player draws the paper's focus edge, 1 px of its secondary ink just inside the player
    // and over the picture, where the page's usual inset edge would sit under the film; never a ring outside it.
    const screen = await render(
      <main className={PAPER}>
        <LaunchFilm />
      </main>,
    );
    const root = screen.container.querySelector('main') as HTMLElement;
    const video = screen.container.querySelector('video') as HTMLVideoElement;
    const frame = video.parentElement as HTMLElement;
    const overlay = () => getComputedStyle(frame, '::after');
    expect(overlay().boxShadow).toBe('none');
    await userEvent.keyboard('{Shift}');
    video.focus();
    expect(video.matches(':focus-visible')).toBe(true);
    expect([getComputedStyle(video).outlineStyle, overlay().boxShadow]).toEqual([
      'none',
      `${tokenColor('--line-focus', root)} 0px 0px 0px 1px inset`,
    ]);
    // The edge lies over the player's whole box, rounded as it is, and lets a click through to the player.
    expect(overlay().pointerEvents).toBe('none');
    expect(overlay().borderTopLeftRadius).toBe(getComputedStyle(video).borderTopLeftRadius);
    expect(frame.getBoundingClientRect().toJSON()).toEqual(video.getBoundingClientRect().toJSON());
    await screen.unmount();
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
        'Claude’s τ³-Banking pass^1 rose from 24.7% (Sierra) to 56.0% (Fireworks) in ten months',
      );
      expect(first?.querySelector('[data-evidence] a')?.getAttribute('href')).toBe('https://taubench.com/leaderboard');
      expect(
        [...(first?.querySelectorAll('[data-watch] > *') ?? [])].map((part) => part.textContent),
      ).toEqual(['Watch for', 'Sonnet 5.5’s score, and the next Claude on Sierra’s own board']);
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
      const glued = pills[0]?.closest<HTMLElement>('.cd-about-nowrap');
      expect(glued?.textContent).toBe('measured: violations;');
      // The pill and its punctuation are one box that moves whole to the next line, as the owner's name does in
      // the public chat's disclosure, so the punctuation sits on the pill's line.
      const glue = glued ?? document.body;
      expect([getComputedStyle(glue).display, getComputedStyle(glue).maxWidth]).toEqual(['inline-block', '100%']);
      const mark = document.createRange();
      mark.selectNodeContents(glue.lastChild as Node);
      const [markBox, pillBox] = [mark.getBoundingClientRect(), (pills[0] as HTMLElement).getBoundingClientRect()];
      expect(markBox.top < pillBox.bottom && markBox.bottom > pillBox.top, `"${glue.lastChild?.textContent}" beside the pill`).toBe(true);
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
          <LaunchFilm compact={compact} />
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
        // The chart: the releases, the top score's ring, Opus 5.5's ring, the trend and its dashed run ahead of today,
        // the bar, today's rule and the prediction's bracket, the leaders that tie each label to its point, and the
        // key's dot, ring and dash.
        ['[data-point="claude"]', (el) => getComputedStyle(el).fill],
        ['[data-point="top"]', (el) => getComputedStyle(el).stroke],
        ['[data-ring]', (el) => getComputedStyle(el).stroke],
        ['[data-tau3-part="fit"]', (el) => getComputedStyle(el).stroke],
        // The trend through the scores is drawn lighter than its run ahead of today, but still holds 3:1.
        ['[data-tau3-part="trend"]', (el) => {
          const { stroke, strokeOpacity } = getComputedStyle(el);
          return stroke.replace(/^rgb\((.*)\)$/, `rgba($1, ${strokeOpacity})`);
        }],
        ['.cd-about-chart__bar', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__rule', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__leader', (el) => getComputedStyle(el).stroke],
        ['.cd-about-chart__key-dot', (el) => getComputedStyle(el).backgroundColor],
        ['.cd-about-chart__key-ring', (el) => getComputedStyle(el).borderTopColor],
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
      // A focus edge, in the paper's secondary ink, never its link blue, on the paper and on a figure's card.
      const ring = tokenColor('--line-focus', root);
      expect(ring, where).toBe('rgb(92, 88, 80)');
      for (const on of [paper, ground(all('.cd-about-frame')[0] as Element)]) expect(contrastRatio(ring, on), where).toBeGreaterThanOrEqual(3);
      await screen.unmount();
    }
  });
});
