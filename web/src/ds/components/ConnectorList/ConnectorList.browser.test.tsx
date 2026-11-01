/**
 * The connector list's summary when the rules version changes under it, with motion on (this
 * project's context emulates reduced motion, so a test that needs motion turns it on for itself):
 * only the words that changed cross-fade.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { expectComputed } from '../../test/expectComputed.ts';
import { motion } from '../../test/reducedMotion.ts';
import { ConnectorList } from './ConnectorList.tsx';

/** The summary line for rules version `n`. */
const summaryFor = (n: number) => `Version ${n} of your rules, checked against the always-on rules`;

/** A place to draw the list, and a way to draw it again with a new summary. */
function mount(): (summary: string) => HTMLElement {
  const el = document.createElement('div');
  el.style.width = '960px';
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  return (summary) => {
    flushSync(() =>
      root.render(
        <ConnectorList summary={summary}>
          <p>Quotes</p>
        </ConnectorList>,
      ),
    );
    return el;
  };
}

it('only_the_version_number_cross_fades', async () => {
  await motion();
  const draw = mount();
  draw(summaryFor(7));
  const line = draw(summaryFor(8)).querySelector<HTMLElement>('.cd-connector-list__summary');
  if (!line) throw new Error('no summary');
  const fade = line.querySelector<HTMLElement>('.cd-cross-fade');
  // The number alone: 7 fades out over 8 as it fades in, on motion-base; the words around stay.
  expect(fade?.querySelector('.cd-cross-fade__was')?.textContent).toBe('7');
  expect(fade?.querySelector('.cd-cross-fade__now')?.textContent).toBe('8');
  expectComputed(fade?.querySelector('.cd-cross-fade__now') ?? line, { animationName: 'cd-cross-fade-in', animationDuration: '0.2s' });
  expect(line.firstChild?.textContent).toBe('Version ');
  await Promise.all(line.getAnimations({ subtree: true }).map((a) => a.finished));
  await expect.poll(() => line.querySelector('.cd-cross-fade')).toBeNull();
  expect(line.textContent).toBe(summaryFor(8));
});

it('the_summary_changes_at_once_under_reduced_motion', () => {
  const draw = mount();
  draw(summaryFor(7));
  const line = draw(summaryFor(8)).querySelector<HTMLElement>('.cd-connector-list__summary');
  expect(line?.querySelector('.cd-cross-fade')).toBeNull();
  expect(line?.textContent).toBe(summaryFor(8));
});
