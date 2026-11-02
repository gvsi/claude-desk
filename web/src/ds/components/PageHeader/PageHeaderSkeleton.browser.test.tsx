/**
 * PageHeaderSkeleton in Chromium: a header that knows its subtitle's words draws them in as many lines
 * from its first frame as it keeps, at every column width, so nothing under it moves while it loads.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { PageHeaderSkeleton } from './PageHeaderSkeleton.tsx';

/** A subtitle as long as a page's real one, which wraps to two or three lines at narrow desktop widths. */
const SUBTITLE = 'Requests your Desk turned down, replies it stopped before they were shown, and the signed record of every entry.';

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** What the header draws now: its subtitle's line shapes, the box they take, and where its action sits. */
function drawn(header: HTMLElement) {
  const subtitle = header.querySelector<HTMLElement>('.cd-page-header__subtitle')!;
  const shown = [...subtitle.children].filter((line) => getComputedStyle(line).display !== 'none');
  const action = header.querySelector<HTMLElement>('.cd-page-header__actions')!.getBoundingClientRect();
  return { lines: shown.length, subtitle: Math.round(subtitle.getBoundingClientRect().height), action: Math.round(action.top) };
}

it('page_header_skeleton_draws_its_measured_subtitle_once_at_every_width', async () => {
  await document.fonts.ready;
  const moved: string[] = [];
  for (let width = 560; width <= 960; width += 8) {
    const box = document.createElement('div');
    box.style.width = `${width}px`;
    document.body.append(box);
    const root = createRoot(box);
    onTestFinished(() => {
      root.unmount();
      box.remove();
    });
    // The first frame: the commit and the layout work it starts, before the browser paints.
    flushSync(() => root.render(
      <PageHeaderSkeleton subtitle={SUBTITLE} actions={<Skeleton shape="block" width={160} height="var(--size-control)" />} />,
    ));
    const header = box.querySelector<HTMLElement>('.cd-page-header')!;
    const first = drawn(header);
    for (let i = 0; i < 4; i += 1) await frame();
    const settled = drawn(header);
    if (JSON.stringify(first) !== JSON.stringify(settled)) moved.push(`${width}px: first ${JSON.stringify(first)}, then ${JSON.stringify(settled)}`);
    root.unmount();
    box.remove();
  }
  expect(moved, 'widths where the header redraws after its first frame').toEqual([]);
});
