/**
 * Watching a `SkeletonScreen` from before it mounts, for the design system's stories and browser
 * tests: when it appeared, and each state its layer took, read in the moment React commits it.
 */
import { waitFor } from 'storybook/test';

/** What a region's layer is doing: its `data-state`, or gone. */
export type LayerState = 'waiting' | 'shown' | 'leaving' | 'gone';

/** A region's parts, as the screen tests name them. */
export interface RegionParts {
  region: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  layer: HTMLElement | null;
}

/** A region's status, its body and its layer, when it has one. */
export function partsOf(region: HTMLElement): RegionParts {
  const [status, body] = [...region.children] as HTMLElement[];
  if (!status || !body) throw new Error('the region has no status and body');
  const layer = [...body.children].find((child): child is HTMLElement => child.classList.contains('cd-skeleton-screen__layer')) ?? null;
  return { region, status, body, layer };
}

/** The first region under `root`: the outermost, when one holds another. */
export function regionIn(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.cd-skeleton-screen');
}

/**
 * Watches the first region under `root` from before the story mounts: when it appeared, and each
 * state its layer took, read when React commits it. `onChange` runs in that same moment, before the
 * browser draws, so it can measure the frame the state is first drawn in.
 */
export function watchRegion(root: HTMLElement, onChange?: (state: LayerState, parts: RegionParts) => void) {
  const states: { state: LayerState; at: number }[] = [];
  let appeared: number | null = null;
  const read = () => {
    const region = regionIn(root);
    if (!region) return;
    appeared ??= performance.now();
    const parts = partsOf(region);
    const state = (parts.layer?.dataset.state ?? 'gone') as LayerState;
    if (states.at(-1)?.state === state) return;
    states.push({ state, at: performance.now() });
    onChange?.(state, parts);
  };
  const observer = new MutationObserver(read);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  return {
    states,
    /** When the region first appeared, in ms on the page's clock. */
    appeared: () => {
      if (appeared === null) throw new Error('no region appeared');
      return appeared;
    },
    /** Resolves once the layer has taken `state`. */
    reached: (state: LayerState, timeout = 4000) =>
      waitFor(
        () => {
          const seen = states.find((entry) => entry.state === state);
          if (!seen) throw new Error(`the layer never took "${state}"; it took ${states.map((entry) => entry.state).join(', ')}`);
          return seen;
        },
        { timeout },
      ),
    stop: () => observer.disconnect(),
  };
}
