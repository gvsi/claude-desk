import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { TakeOverBar } from './TakeOverBar.tsx';

it('the_visitor_hint_uses_the_available_width', () => {
  const host = document.createElement('div');
  host.style.width = 'var(--size-reading)';
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(
    <TakeOverBar mode="ai" visitorName="Visitor" ownerName="Mike Turner"
      onTakeOver={() => {}} onHandBack={() => {}} onResume={() => {}} />,
  ));
  const bar = host.querySelector('.cd-take-over') as HTMLElement;
  const action = host.querySelector('.cd-take-over__action') as HTMLElement;
  const hint = action.querySelector('p') as HTMLElement;
  const lines = () => {
    const range = document.createRange();
    range.selectNodeContents(hint);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  };
  expect(hint.textContent).toBe('Visitor sees “Mike Turner joined the chat.”');
  expect(action.getBoundingClientRect().width).toBe(bar.getBoundingClientRect().width);
  expect(lines()).toBe(1);
  expect(getComputedStyle(hint).whiteSpace).toBe('normal');

  // A phone may wrap naturally; neither the line nor the bar can overflow it.
  host.style.width = 'calc(390px - var(--space-24) * 2)';
  expect(host.scrollWidth).toBe(host.clientWidth);
  expect(hint.scrollWidth).toBe(hint.clientWidth);
});
