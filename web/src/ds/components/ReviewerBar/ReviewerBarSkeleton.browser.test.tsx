import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { beforeAll, expect, it, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';

import { FONT_SHEET_URL, loadWebFonts } from '../../test/fonts.ts';
import { ReviewerBar } from './ReviewerBar.tsx';
import { ReviewerBarSkeleton } from './ReviewerBarSkeleton.tsx';

beforeAll(loadWebFonts);

it('reviewer_shape_measures_the_control_with_different_font_metrics', async () => {
  const host = document.createElement('div');
  const metrics = document.createElement('style');
  metrics.textContent = '.cd-button { letter-spacing: 0.2em; }';
  document.head.append(metrics);
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); metrics.remove(); });
  flushSync(() => root.render(<><ReviewerBar ownerName="Maria Rivera" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const real = host.querySelector('.cd-button')!;
  const shape = host.querySelector('.cd-reviewer-bar > .cd-skeleton')!;
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
  flushSync(() => root.render(<><ReviewerBar ownerName="Maria Rivera" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const real = host.querySelector('.cd-button')!;
  const shape = host.querySelector('.cd-reviewer-bar > .cd-skeleton')!;
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
  flushSync(() => root.render(<><ReviewerBar ownerName="Maria Rivera" onStartOver={() => {}} /><ReviewerBarSkeleton /></>));
  const [real, shape] = host.querySelectorAll('.cd-reviewer-bar');
  // Resize the same mounted bar too: wrapping follows available space, not a phone breakpoint.
  for (const width of [620, 390, 440, 480, 540, 639, 640, 768, 1440]) {
    await page.viewport(width, width === 390 ? 844 : 900);
    await expect.poll(() => Math.abs(real!.getBoundingClientRect().height - shape!.getBoundingClientRect().height), {
      message: `reviewer bar height at ${width}px`,
    }).toBeLessThanOrEqual(2);
    const action = real!.querySelector('.cd-button')!.getBoundingClientRect();
    const control = shape!.querySelector(':scope > .cd-skeleton')!.getBoundingClientRect();
    expect(Math.abs(action.left - control.left), `control left at ${width}px`).toBeLessThanOrEqual(2);
    expect(Math.abs((action.top - real!.getBoundingClientRect().top) - (control.top - shape!.getBoundingClientRect().top)), `control top at ${width}px`).toBeLessThanOrEqual(2);
    expect(shape!.textContent).toBe('');
  }
});
