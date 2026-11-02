import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { beforeAll, expect, it, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';

import { FONT_SHEET_URL, loadWebFonts } from '../../test/fonts.ts';
import { ReviewerBar } from './ReviewerBar.tsx';
import { ReviewerBarSkeleton } from './ReviewerBarSkeleton.tsx';

beforeAll(loadWebFonts);

it('reviewer_shape_matches_the_real_bar_on_its_first_commit_at_390px', async () => {
  await page.viewport(390, 844);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); });
  flushSync(() => root.render(<><ReviewerBar ownerName="Mike Turner" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const [real, shape] = host.querySelectorAll('.cd-reviewer-bar');
  expect(shape!.querySelectorAll('.cd-skeleton-line').length).toBe(2);
  expect(shape!.getBoundingClientRect().height).toBe(real!.getBoundingClientRect().height);
  const ownerName = 'Alexandria Turner de la Cruz '.repeat(3).trim();
  flushSync(() => root.render(<><ReviewerBar ownerName={ownerName} onStartOver={() => {}} /><ReviewerBarSkeleton ownerName={ownerName} /></>));
  const range = document.createRange();
  range.selectNodeContents(real!.querySelector('.cd-reviewer-bar__text')!);
  const lineCount = new Set([...range.getClientRects()].map((rect) => rect.top)).size;
  expect(lineCount).toBeGreaterThan(2);
  expect(shape!.querySelectorAll('.cd-skeleton-line').length).toBe(lineCount);
  expect(shape!.getBoundingClientRect().height).toBe(real!.getBoundingClientRect().height);
});

it('reviewer_shape_measures_the_control_with_different_font_metrics', async () => {
  const host = document.createElement('div');
  const metrics = document.createElement('style');
  metrics.textContent = '.cd-button { letter-spacing: 0.2em; }';
  document.head.append(metrics);
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); metrics.remove(); });
  flushSync(() => root.render(<><ReviewerBar ownerName="Mike Turner" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const real = host.querySelector('.cd-button')!;
  const shape = host.querySelector('.cd-reviewer-bar__actions > .cd-skeleton:last-child')!;
  expect(shape.textContent).toBe('');
  await expect.poll(() => Math.abs(real.getBoundingClientRect().width - shape.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
});

it('reviewer_shape_remeasures_when_its_font_loads_after_mount', { timeout: 15_000 }, async () => {
  await page.viewport(480, 900);
  const sheet = await (await fetch(FONT_SHEET_URL)).text();
  const rule = sheet.match(/@font-face\s*\{[^}]*font-family:\s*['"]Hanken Grotesk['"][^}]*unicode-range:\s*U\+0000-00FF[^}]*\}/)?.[0];
  const source = rule?.match(/url\(([^)]+)\)/)?.[1];
  expect(source, 'the real Hanken Grotesk Latin face').toBeDefined();
  const host = document.createElement('div');
  host.style.setProperty('--font-sans', '"Late Skeleton Control", monospace');
  document.body.append(host);
  const root = createRoot(host);
  const late = new FontFace('Late Skeleton Control', `url(${source})`, { weight: '300 700' });
  onTestFinished(() => { root.unmount(); host.remove(); document.fonts.delete(late); });
  flushSync(() => root.render(<><ReviewerBar ownerName="Mike Turner" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const real = host.querySelector('.cd-button')!;
  const shape = host.querySelector('.cd-reviewer-bar__actions > .cd-skeleton:last-child')!;
  await expect.poll(() => Math.abs(real.getBoundingClientRect().width - shape.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
  const [realBar, shapeBar] = host.querySelectorAll('.cd-reviewer-bar');
  await expect.poll(() => Math.abs(realBar!.getBoundingClientRect().height - shapeBar!.getBoundingClientRect().height)).toBeLessThanOrEqual(2);
  const barBefore = realBar!.getBoundingClientRect().height;
  const before = real.getBoundingClientRect().width;
  document.fonts.add(late);
  await late.load();
  await document.fonts.ready;
  expect(Math.abs(real.getBoundingClientRect().width - before)).toBeGreaterThan(2);
  await expect.poll(() => Math.abs(real.getBoundingClientRect().width - shape.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
  expect(barBefore - realBar!.getBoundingClientRect().height).toBeGreaterThan(2);
  await expect.poll(() => Math.abs(realBar!.getBoundingClientRect().height - shapeBar!.getBoundingClientRect().height)).toBeLessThanOrEqual(2);
  expect(shape.textContent).toBe('');
});

it('reviewer_shape_follows_natural_text_wrapping_between_breakpoints', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); });
  flushSync(() => root.render(<><ReviewerBar ownerName="Mike Turner" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const [real, shape] = host.querySelectorAll('.cd-reviewer-bar');
  // Resize the same mounted bar too: wrapping follows available space, not a phone breakpoint.
  for (const width of [620, 280, 320, 390, 440, 480, 540, 639, 640, 768, 1440]) {
    await page.viewport(width, width === 390 ? 844 : 900);
    await expect.poll(() => Math.abs(real!.getBoundingClientRect().height - shape!.getBoundingClientRect().height), {
      message: `reviewer bar height at ${width}px`,
    }).toBeLessThanOrEqual(2);
    const text = real!.querySelector('.cd-reviewer-bar__text')!;
    const range = document.createRange();
    range.selectNodeContents(text);
    // The real bar has inline spans, so several rects can share a wrapped line.
    const lineCount = new Set([...range.getClientRects()].map((rect) => rect.top)).size;
    const lines = [...shape!.querySelectorAll<HTMLElement>('.cd-skeleton-line')];
    expect(lines.length, `line count at ${width}px`).toBe(lineCount);
    if (width === 280) expect(lines.length).toBe(3);
    const available = shape!.querySelector('.cd-reviewer-bar__text')!.getBoundingClientRect().width;
    lines.forEach((line, i) => {
      expect(line.style.width).toBe(i === 0 ? 'min(100%, 430px)' : '75%');
      expect(Math.abs(line.getBoundingClientRect().width - (i === 0 ? Math.min(available, 430) : available * 0.75))).toBeLessThanOrEqual(0.02);
    });
    const action = real!.querySelector('.cd-button')!.getBoundingClientRect();
    const control = shape!.querySelector('.cd-reviewer-bar__actions > .cd-skeleton:last-child')!.getBoundingClientRect();
    expect(Math.abs(action.left - control.left), `control left at ${width}px`).toBeLessThanOrEqual(2);
    expect(Math.abs((action.top - real!.getBoundingClientRect().top) - (control.top - shape!.getBoundingClientRect().top)), `control top at ${width}px`).toBeLessThanOrEqual(2);
    expect(shape!.textContent).toBe('');
  }
});
