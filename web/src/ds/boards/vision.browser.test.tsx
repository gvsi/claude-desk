/**
 * The city office's vision page in a desktop window: its suggestions end the conversation's scroll
 * region, right above the pinned composer, so the line their first pick shows could land under the
 * composer, out of view. The pick brings it into the region's view instead, and the focus stays on
 * the chip.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { VISION_INERT_LINE } from '../components/VisionBar/visionInert.tsx';
import { CityOfficeChat } from './vision.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await page.viewport(1280, 820);
});

function one<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

it('inert_suggestion_line_shows_in_view', async () => {
  await page.viewport(1440, 900);
  act(() => root.render(<CityOfficeChat />));
  const scroller = one('.cd-public-shell__scroll');
  // The conversation runs past the region, and is scrolled to its end, as a visitor reading it would.
  await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
  scroller.scrollTop = scroller.scrollHeight;
  const chips = one('.cd-suggestion-chips');
  const payTheFee = [...chips.querySelectorAll<HTMLElement>('button')].find((chip) => chip.textContent === 'Pay the fee');
  if (!payTheFee) throw new Error('no "Pay the fee" chip');

  await userEvent.click(payTheFee);
  const line = chips.nextElementSibling as HTMLElement;
  await expect.element(line).toHaveTextContent(VISION_INERT_LINE);
  await expect.element(payTheFee).toHaveFocus();

  // Fully inside the scroll region's visible box, and nothing over it: not the composer below.
  const box = line.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  expect(box.height).toBeGreaterThan(1);
  expect(box.top).toBeGreaterThanOrEqual(view.top);
  expect(box.bottom).toBeLessThanOrEqual(view.bottom);
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  expect(hit !== null && line.contains(hit)).toBe(true);
});

it('city_office_status_shows_once_in_about_or_the_narrow_header', async () => {
  for (const width of [1512, 900, 899, 390]) {
    act(() => root.render(null));
    await page.viewport(width, 982);
    act(() => root.render(<CityOfficeChat />));
    await vi.waitFor(() => {
      const statuses = container.querySelectorAll('.cd-public-shell__open-status');
      expect(statuses).toHaveLength(1);
      const status = statuses[0]!;
      expect(status.textContent).toBe('Open now, until 4:30 pm');
      expect(status.closest(width >= 900 ? '.cd-public-shell__about' : '.cd-public-shell__brand')).not.toBeNull();
    });
    await expect.element(one('.cd-public-shell__open-status')).toBeVisible();
  }
});
