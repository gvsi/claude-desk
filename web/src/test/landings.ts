/**
 * Which transcript rows land, and which of their lines land with them. A row drawn live
 * (`TranscriptRow`'s `live`) is like any other once its landing has played, so a test can't tell
 * afterwards whether it landed. This records each row the page draws live as it is drawn, from the
 * call to the end of the test, with the lines attached under it that were landing then.
 */
import { onTestFinished } from 'vitest';

const LIVE = 'cd-transcript-row--live';

export interface Landings {
  /** Every row drawn live so far, in the order drawn, those since unmounted included. */
  rows: () => Element[];
  /** The lines attached under `row` that landed with it, as it was drawn. */
  lines: (row: Element) => Element[];
}

export function watchLandings(): Landings {
  const landed = new Map<Element, Element[]>();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const row of [node, ...node.querySelectorAll(`.${LIVE}`)]) {
          if (!row.classList.contains(LIVE) || landed.has(row)) continue;
          const attached = [...row.querySelectorAll(':scope > .cd-transcript-row__margin > *')];
          landed.set(row, attached.filter((line) => getComputedStyle(line).animationName !== 'none'));
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => {
    observer.disconnect();
  });
  return { rows: () => [...landed.keys()], lines: (row) => [...(landed.get(row) ?? [])] };
}
