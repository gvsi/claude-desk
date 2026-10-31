/**
 * A row that arrived live. This project's browser context emulates prefers-reduced-motion:
 * reduce, so the LiveReply story runs with its reduced-motion branch: the reply and its receipts
 * show at once. Tests that need motion turn it on for themselves (`motion`). A row lands once: its
 * landing is spent when it has played, or at once when nothing can play it, so a line attached
 * later shows at once and motion coming back never plays it again. And `live` is read when the row
 * is first drawn, so a re-render neither replays nor cuts the motion.
 */
import { composeStory } from '@storybook/react-vite';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished, vi } from 'vitest';
import { cdp } from 'vitest/browser';

import { expectComputed } from '../../test/expectComputed.ts';
import { MarginNote } from '../MarginNote/MarginNote.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import meta, { LiveReply } from './TranscriptRow.stories.tsx';
import { TranscriptRow } from './TranscriptRow.tsx';

/** Sets prefers-reduced-motion for the page, as a visitor's system setting would. */
async function reduceMotion(reduce: boolean): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }],
  });
}

/** Lets motion play for the rest of the test; reduced motion, as the project has it, comes back after. */
async function motion(): Promise<void> {
  await reduceMotion(false);
  onTestFinished(() => reduceMotion(true));
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
}

/** A root to draw rows into, gone after the test. */
function host() {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  return { el, root };
}

/** Dana's question as a row, live or not, with `lines` attached under it. */
function row(live: boolean | undefined, lines: readonly string[], text = 'How much is drain clearing?') {
  return (
    <TranscriptRow key={text} live={live} margin={lines.map((line) => <MarginNote key={line} text={line} />)}>
      <VisitorMessage text={text} />
    </TranscriptRow>
  );
}

/** What moves under `el` now, by animation name. */
function moving(el: Element): string[] {
  return el.getAnimations({ subtree: true }).map((a) => (a instanceof CSSAnimation ? a.animationName : 'other'));
}

/** Two frames: long enough for a style change to start or stop an animation. */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const LINES = ['Quoted from your price list.', 'Name and phone saved to Customers as a new lead.'];

it('live_reply_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(LiveReply, meta);
  await story.run();

  const reply = document.querySelector('.cd-claude-message')?.closest('.cd-transcript-row');
  if (!reply) throw new Error('no row holds the reply');
  for (const el of [reply, ...reply.querySelectorAll('*')]) expect(getComputedStyle(el).animationName).toBe('none');
  // Nothing played it, so its arrival is spent.
  expect(reply.classList.contains('cd-transcript-row--live')).toBe(false);
});

it('drawn_live_under_reduced_motion_never_lands_later', async () => {
  const { el, root } = host();
  flushSync(() => root.render(row(true, LINES)));
  // Motion comes back once the row is shown: it was shown still, and it stays so.
  await reduceMotion(false);
  onTestFinished(() => reduceMotion(true));
  await frames();
  expect(moving(el)).toEqual([]);
});

it('a_landed_row_stays_still_when_motion_goes_and_comes_back', async () => {
  await motion();
  const { el, root } = host();
  flushSync(() => root.render(row(true, LINES)));
  expect(moving(el)).not.toEqual([]);
  await vi.waitFor(() => expect(moving(el)).toEqual([]));

  await reduceMotion(true);
  await frames();
  await reduceMotion(false);
  await frames();
  expect(moving(el)).toEqual([]);
});

it('a_line_attached_after_the_landing_shows_at_once', async () => {
  await motion();
  const { el, root } = host();
  flushSync(() => root.render(row(true, LINES)));
  await vi.waitFor(() => expect(moving(el)).toEqual([]));

  // A line that comes later (a held request's outcome, say) shows at once, with no beat to wait for.
  flushSync(() => root.render(row(true, [...LINES, 'Cancelled'])));
  const later = el.querySelector('.cd-transcript-row__margin')?.lastElementChild;
  if (!later) throw new Error('the later line is attached');
  expectComputed(later, { animationName: 'none', animationDelay: '0s' });
  expect(moving(el)).toEqual([]);
});

it('live_is_read_once', async () => {
  await motion();
  const { el, root } = host();
  const draw = (live: boolean | undefined, text: string) => flushSync(() => root.render(row(live, [], text)));
  const isLive = () => el.querySelector('.cd-transcript-row')?.classList.contains('cd-transcript-row--live');

  // Drawn live, it stays so through a re-render that clears the flag: the motion isn't cut short.
  draw(true, 'Arrived live');
  expect(isLive()).toBe(true);
  draw(false, 'Arrived live');
  expect(isLive()).toBe(true);
  expect(moving(el)).toEqual(['cd-transcript-row-rise']);

  // Drawn still, as a row read from history is, it never starts moving later.
  draw(undefined, 'Read from history');
  expect(isLive()).toBe(false);
  draw(true, 'Read from history');
  expect(isLive()).toBe(false);
  expect(moving(el)).toEqual([]);
});
