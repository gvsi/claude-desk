import { expect, it, onTestFinished, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { Skeleton, SkeletonScreen } from '../ds/index.ts';
import { expectSkeletonLoad, expectSkeletonStill, type SkeletonLoad } from './skeleton.ts';

/** A second commit can land the footer during the fade, or after a visibly empty replacement. */
function footerLoad(when: 'same-commit' | 'during-fade' | 'after-paint'): SkeletonLoad {
  const host = document.createElement('div');
  host.style.cssText = 'position: fixed; top: 40px; left: 40px; width: 100px';
  document.body.append(host);
  const root = createRoot(host);
  let frame = 0;
  const draw = (loading: boolean, footer: boolean) => flushSync(() => root.render(
    <SkeletonScreen loading={loading} status="Opening the helper fixture" skeleton={<Skeleton shape="block" width={100} height={20} anchor="owner-footer" />}>
      {footer && <footer className="helper-footer" style={{ width: 100, height: 20 }} />}
    </SkeletonScreen>,
  ));
  const observer = new MutationObserver(() => {
    if (host.querySelector('.cd-skeleton-screen__layer')) return;
    observer.disconnect();
    // Two frame callbacks leave one paint without a footer before it is inserted.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => draw(false, true));
    });
  });
  onTestFinished(() => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    root.unmount();
    host.remove();
  });
  return {
    status: 'Opening the helper fixture',
    anchors: [{ name: 'owner-footer', page: '.helper-footer', size: true }],
    open: async () => { draw(true, false); },
    release: () => {
      if (when === 'after-paint') observer.observe(host, { subtree: true, childList: true });
      draw(false, when === 'same-commit');
      if (when === 'during-fade') frame = requestAnimationFrame(() => draw(false, true));
    },
  };
}

it('rejects_an_anchor_that_first_lands_after_the_fade_is_gone', async () => {
  await expect(expectSkeletonLoad(footerLoad('after-paint'))).rejects.toThrow(
    'owner-footer (.helper-footer) was not on the page while the layer faded',
  );
});

it('rejects_an_anchor_that_first_lands_after_the_still_replacement_paints', async () => {
  await expect(expectSkeletonStill(footerLoad('after-paint'))).rejects.toThrow(
    'owner-footer (.helper-footer) was not on the page at the first paint after replacement',
  );
});

it('accepts_an_anchor_that_lands_on_a_later_commit_during_the_fade', async () => {
  await expectSkeletonLoad(footerLoad('during-fade'));
});

it('accepts_an_anchor_in_the_still_replacement_commit', async () => {
  await expectSkeletonStill(footerLoad('same-commit'));
});

it('names_the_skipped_fade_before_checking_anchors', async () => {
  const load = footerLoad('same-commit');
  const release = load.release;
  load.release = () => {
    // Skip the fade in the component without changing the earlier sweep/style assertions.
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    try {
      release();
    } finally {
      media.mockRestore();
    }
  };
  await expect(expectSkeletonLoad(load)).rejects.toThrow('the layer never started leaving');
});

it('does_not_remeasure_recorded_anchors_for_unrelated_mutations', async () => {
  const measurements = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  onTestFinished(() => measurements.mockRestore());
  const noise = document.createElement('div');
  document.body.append(noise);
  const observer = new MutationObserver(() => {
    if (document.querySelector('.cd-skeleton-screen__layer')) return;
    observer.disconnect();
    // Separate observer deliveries after both transition positions have been recorded.
    queueMicrotask(() => {
      noise.textContent = 'First unrelated change';
      queueMicrotask(() => { noise.textContent = 'Second unrelated change'; });
    });
  });
  onTestFinished(() => { observer.disconnect(); noise.remove(); });

  const load = footerLoad('during-fade');
  const release = load.release;
  load.release = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    release();
  };
  await expectSkeletonLoad(load);

  expect(noise.textContent).toBe('Second unrelated change');
  const footerReads = measurements.mock.contexts.filter((element) => element instanceof HTMLElement && element.classList.contains('helper-footer'));
  expect(footerReads, 'one measurement during the fade, one at replacement, and one final measurement').toHaveLength(3);
});
