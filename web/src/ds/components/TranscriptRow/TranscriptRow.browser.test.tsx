/**
 * A row that arrived live. This project's browser context emulates prefers-reduced-motion:
 * reduce, so the LiveReply story runs with its reduced-motion branch: the reply and its receipts
 * show at once. Tests that need motion turn it on for themselves (`motion`). A row lands once: its
 * landing is spent when it has played, or at once when nothing can play it, so a line attached
 * later shows at once and motion coming back never plays it again. And `live` is read when the row
 * is first drawn, so a re-render neither replays nor cuts the motion.
 */
import { composeStory } from '@storybook/react-vite';
import { act, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished, vi } from 'vitest';

import { proseBlock, rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { motion, reduceMotion } from '../../test/reducedMotion.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { MarginNote } from '../MarginNote/MarginNote.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import meta, { LiveReply } from './TranscriptRow.stories.tsx';
import { TranscriptRow } from './TranscriptRow.tsx';

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
  // The last animation can finish before animationend, the landing re-check and React's render.
  // Wait for the row's spent landing state before attaching a line that must not animate.
  await vi.waitFor(() => expect(el.querySelector('.cd-transcript-row--live')).toBeNull());

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

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Runs `draw` inside act(), whatever the test's clock. */
function inAct(draw: () => void): void {
  const was = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(draw);
  globalThis.IS_REACT_ACT_ENVIRONMENT = was;
}

/**
 * Draws `ui` inside act(), on a clock the test moves (`fake`), or on the page's own clock, which
 * plays the reveal and the fades outside act() (`real`). Gone, and the clock real again, after the test.
 */
function actHost(ui: ReactElement, clock: 'fake' | 'real' = 'fake') {
  if (clock === 'fake') vi.useFakeTimers();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  inAct(() => root.render(ui));
  globalThis.IS_REACT_ACT_ENVIRONMENT = clock === 'fake';
  onTestFinished(() => {
    inAct(() => root.unmount());
    el.remove();
    vi.useRealTimers();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });
  return {
    el,
    rerender: (next: ReactElement) => inAct(() => root.render(next)),
    pass: (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
  };
}

/** About 100 characters: half a second at the reveal's pace. */
const WORDS = 'Drain clearing is one visit. Here is the quote, and Maria can come by this week to clear it.';

/** Claude's quote reply as a row that arrived live and is revealed, with `lines` attached under it. */
function revealed(lines: readonly string[], blocks = [proseBlock(WORDS), rivera.blocks.quote.en]) {
  return (
    <TranscriptRow live margin={lines.map((line) => <MarginNote key={line} text={line} />)}>
      <ClaudeMessage blocks={blocks} language="en" ownerName={rivera.business.ownerName} reveal />
    </TranscriptRow>
  );
}

/** How each line attached under `el`'s row comes in: shown or not, and its motion's name and delay. */
function lineArrivals(el: Element) {
  return [...el.querySelectorAll(':scope .cd-transcript-row__margin > *')].map((line) => {
    const style = getComputedStyle(line);
    return { visibility: style.visibility, name: style.animationName, delay: style.animationDelay };
  });
}

it('a_revealed_replys_lines_wait_for_its_words_then_follow_its_cards', async () => {
  await motion();
  const { el, pass } = actHost(revealed(LINES));
  const main = el.querySelector('.cd-transcript-row__main') as Element;

  // The words come in on their own: the message doesn't rise, and what is attached waits unseen.
  expect(getComputedStyle(main).animationName).toBe('none');
  expect(lineArrivals(el).map((line) => line.visibility)).toEqual(['hidden', 'hidden']);
  await pass(300);
  expect(lineArrivals(el).map((line) => line.visibility)).toEqual(['hidden', 'hidden']);

  // Once the words are whole, the card comes in a beat after them, then each line a beat apart.
  await pass(400);
  expect(lineArrivals(el)).toEqual([
    { visibility: 'visible', name: 'cd-transcript-row-follow', delay: '0.24s' },
    { visibility: 'visible', name: 'cd-transcript-row-follow', delay: '0.36s' },
  ]);
});

it('a_revealed_reply_arrives_once_then_a_line_attached_later_shows_at_once', async () => {
  await motion();
  const { el, rerender } = actHost(revealed(LINES), 'real');
  // Once everything has come in, the row and its reply are still, as rows read from history are.
  await vi.waitFor(
    () => {
      expect(el.querySelector('.cd-transcript-row--live')).toBeNull();
      expect(moving(el)).toEqual([]);
    },
    { timeout: 3_000 },
  );
  expect(el.querySelectorAll('[data-sd-animate]')).toHaveLength(0);

  // A line that comes later (a held request's outcome, say) shows at once, with no beat to wait for.
  rerender(revealed([...LINES, 'Cancelled']));
  expect(lineArrivals(el).at(-1)).toEqual({ visibility: 'visible', name: 'none', delay: '0s' });
  expect(moving(el)).toEqual([]);
});

it('under_reduced_motion_a_revealed_reply_and_its_lines_show_at_once', () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const { el } = actHost(revealed(LINES));
  expect(el.querySelector('.cd-md')?.textContent).toBe(WORDS);
  expect(lineArrivals(el).map(({ visibility, name }) => ({ visibility, name }))).toEqual([
    { visibility: 'visible', name: 'none' },
    { visibility: 'visible', name: 'none' },
  ]);
  expect(moving(el)).toEqual([]);
  // Nothing played it, so its arrival is spent.
  expect(el.querySelector('.cd-transcript-row--live')).toBeNull();
});

/** Dana's quote ran on its own: a receipt that draws its check. */
const RAN = receiptFromEvent(rivera.events.quoteTurn.find((event) => event.type === 'receipt') as Parameters<typeof receiptFromEvent>[0]);

it('a_receipts_dot_and_check_wait_with_its_line_then_come_on_its_beat', async () => {
  await motion();
  const { el, pass } = actHost(
    <TranscriptRow live margin={[<MarginReceipt key="ran" source={RAN.source} plain={RAN.plain} ledgerSeq={RAN.ledgerSeq} drawCheck />]}>
      <ClaudeMessage blocks={[proseBlock(WORDS), rivera.blocks.quote.en]} language="en" ownerName={rivera.business.ownerName} reveal />
    </TranscriptRow>,
  );
  const dot = el.querySelector('.cd-margin-line__dot > *') as Element;
  const check = el.querySelector('.cd-margin-line__check path') as Element;
  // While the words come in, nothing on the line plays where no one can see it.
  expect([getComputedStyle(dot).animationName, getComputedStyle(check).animationName]).toEqual(['none', 'none']);

  // Then the dot grows and the check draws as the line comes in, on its beat after the card.
  await pass(700);
  expectComputed(dot, { animationName: 'cd-margin-line-dot', animationDelay: '0.24s' });
  expectComputed(check, { animationName: 'cd-margin-line-draw', animationDelay: '0.24s' });
});

it('a_line_shown_before_its_row_arrived_shows_at_once_under_a_revealed_reply', async () => {
  await motion();
  const { el } = actHost(
    <TranscriptRow live margin={[<MarginReceipt key="ran" source={RAN.source} plain={RAN.plain} ledgerSeq={RAN.ledgerSeq} shownBefore />]}>
      <ClaudeMessage blocks={[proseBlock(WORDS)]} language="en" ownerName={rivera.business.ownerName} reveal />
    </TranscriptRow>,
  );
  // Already read under the question, it doesn't wait for the words.
  expect(lineArrivals(el)).toEqual([{ visibility: 'visible', name: 'none', delay: '0s' }]);
});
