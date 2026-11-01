/**
 * Watching a reply of Claude's come in on a real screen, which runs with motion: every frame, from
 * the frame it is first drawn until its words are whole and nothing in its row moves, what its
 * words show, and how its cards and the lines attached under its row come in.
 */
import { expect, onTestFinished } from 'vitest';

/** How long a reply may take to come in and settle before the watch gives up: a reveal takes at most about 3 s. */
const SETTLE_TIMEOUT_MS = 8_000;

/** How a card or an attached line comes in: shown or not, and its motion's name and delay. */
export interface Arrival {
  visibility: string;
  name: string;
  delay: string;
}

export interface RevealFrame {
  /** The reply's words as shown, block by block. */
  words: string;
  /** Its words are still being revealed. */
  revealing: boolean;
  cards: Arrival[];
  lines: Arrival[];
}

function arrivalOf(el: Element): Arrival {
  const style = getComputedStyle(el);
  return { visibility: style.visibility, name: style.animationName, delay: style.animationDelay };
}

/**
 * Reads every frame of the message of Claude's at `nth` on the page (by default the next one it
 * draws, after those it shows now), from its first frame until its words are whole and nothing in
 * its row has moved for two frames running. Start it before the reply can arrive.
 */
export function watchReveal(nth: number = document.querySelectorAll('.cd-claude-message').length): Promise<RevealFrame[]> {
  const before = nth;
  const frames: RevealFrame[] = [];
  const started = performance.now();
  let still = 0;
  return new Promise((resolve, reject) => {
    const step = () => {
      const message = document.querySelectorAll('.cd-claude-message')[before];
      const row = message?.closest('.cd-transcript-row');
      if (message && row) {
        const frame = {
          words: [...message.querySelectorAll('.cd-md')].map((md) => md.textContent ?? '').join('\n'),
          revealing: message.classList.contains('cd-claude-message--revealing'),
          cards: [...message.querySelectorAll(':scope > .cd-reply-card')].map(arrivalOf),
          lines: [...row.querySelectorAll(':scope > .cd-transcript-row__margin > *')].map(arrivalOf),
        };
        frames.push(frame);
        const moving = row.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running');
        still = frame.revealing || moving ? 0 : still + 1;
        if (still >= 2) {
          resolve(frames);
          return;
        }
      }
      if (performance.now() - started > SETTLE_TIMEOUT_MS) reject(new Error('the reply never came in and settled'));
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * The reply was revealed as the signed boards draw it: its words grew from its first ones to the
 * whole, over several frames, each frame a start of the whole; while they did, its cards and the
 * lines attached under it waited unseen; and once they were whole, each card, then each line, came
 * in on its own beat, `motion-follow` apart, in order (`delays`, in seconds, cards first).
 */
export function expectRevealed(frames: readonly RevealFrame[], delays: { cards: readonly number[]; lines: readonly number[] }): void {
  const whole = frames.at(-1)?.words ?? '';
  const revealing = frames.filter((frame) => frame.revealing);
  expect(revealing.length, 'frames while the words came in').toBeGreaterThan(2);
  expect(frames[0]?.words.length).toBeLessThan(whole.length);
  for (const [index, frame] of frames.entries()) {
    expect(whole.startsWith(frame.words), frame.words).toBe(true);
    if (index > 0) expect(frame.words.length).toBeGreaterThanOrEqual(frames[index - 1]?.words.length ?? 0);
  }
  for (const frame of revealing) {
    expect(frame.cards.map((card) => card.visibility)).toEqual(delays.cards.map(() => 'hidden'));
    expect(frame.lines.map((line) => line.visibility)).toEqual(delays.lines.map(() => 'hidden'));
  }
  const first = frames.find((frame) => !frame.revealing);
  if (first === undefined) throw new Error('the words never came in whole');
  expect(first.words).toBe(whole);
  expect(first.cards).toEqual(delays.cards.map((delay) => ({ visibility: 'visible', name: 'cd-claude-message-follow', delay: `${delay}s` })));
  expect(first.lines).toEqual(delays.lines.map((delay) => ({ visibility: 'visible', name: 'cd-transcript-row-follow', delay: `${delay}s` })));
}

/** The reply showed whole from its first frame, its cards and the lines under it at once, with nothing moving in. */
export function expectShownWhole(frames: readonly RevealFrame[]): void {
  const [first] = frames;
  if (first === undefined) throw new Error('the reply was never drawn');
  expect(first.revealing).toBe(false);
  expect(first.words).toBe(frames.at(-1)?.words);
  for (const arrival of [...first.cards, ...first.lines]) expect(arrival).toEqual({ visibility: 'visible', name: 'none', delay: '0s' });
}

/**
 * Every message of Claude's the page draws revealed, from the call to the end of the test, in the
 * order drawn. A revealed message is drawn so from its first frame, so watching what is added
 * finds each one.
 */
export function watchRevealing(): () => Element[] {
  const revealed: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const message of [node, ...node.querySelectorAll('.cd-claude-message')]) {
          if (message.matches('.cd-claude-message--revealing, .cd-claude-message--following') && !revealed.includes(message)) revealed.push(message);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return () => [...revealed];
}
