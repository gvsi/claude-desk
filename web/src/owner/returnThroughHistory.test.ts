import type { MouseEvent } from 'react';
import { expect, it, vi } from 'vitest';

import { returnThroughHistory } from './inAppLinks.ts';

function backClick(overrides: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  const link = document.createElement('a');
  link.href = '/about/vision#vision-pages';
  const words = document.createElement('span');
  link.append(words);
  container.append(link);
  const event = {
    defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    target: words, currentTarget: container, preventDefault: vi.fn(), ...overrides,
  } as unknown as MouseEvent<HTMLElement>;
  return { event, link };
}

it('returns through history for a plain click on a remembered back link', () => {
  const navigate = vi.fn();
  const { event } = backClick();
  returnThroughHistory(navigate, '/about/vision#vision-pages', true)(event);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(-1);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

it.each([
  { defaultPrevented: true }, { button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
])('leaves a non-plain click to its existing handler: %j', (overrides) => {
  const navigate = vi.fn();
  const { event } = backClick(overrides);
  returnThroughHistory(navigate, '/about/vision#vision-pages', true)(event);
  expect(navigate).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it('leaves another link and links to new tabs alone', () => {
  const navigate = vi.fn();
  const { event, link } = backClick();
  link.target = '_blank';
  returnThroughHistory(navigate, '/about/vision#vision-pages', true)(event);
  link.target = '';
  link.href = '/about/proposal';
  returnThroughHistory(navigate, '/about/vision#vision-pages', true)(event);
  expect(navigate).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it('leaves an unremembered back link to normal in-app routing without a fallback', () => {
  const navigate = vi.fn();
  const { event } = backClick();
  returnThroughHistory(navigate, '/about/vision#vision-pages', false)(event);
  expect(navigate).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it('carries the opener into the fallback arrival when the history entry is no longer remembered', () => {
  const navigate = vi.fn();
  const { event } = backClick();
  const fallback = { state: { visionCard: '/vision/city-office' } };
  returnThroughHistory(navigate, '/about/vision#vision-pages', false, fallback)(event);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/about/vision#vision-pages', fallback);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});
