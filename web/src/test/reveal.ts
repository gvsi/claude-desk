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

/** One part of a reply as it played, on the page's animation clock (ms): its words, a card or a line. */
export interface Played {
  part: string;
  start: number;
  end: number;
}

/** What each motion that brings a reply in is part of: its words settling, a card, a line, or a held request's card after it. */
const PARTS: Readonly<Record<string, 'words' | 'card' | 'line' | 'held'>> = {
  'cd-md-settle': 'words',
  'cd-md-settle-marker': 'words',
  'cd-claude-message-follow': 'card',
  'cd-transcript-row-follow': 'line',
  'cd-conversation-held-follow': 'held',
};

/** What comes after `row` and before the next row: in the owner's view, the held requests' cards after the reply. */
function after(row: Element): Element[] {
  const parts: Element[] = [];
  for (let el = row.nextElementSibling; el !== null && !el.classList.contains('cd-transcript-row'); el = el.nextElementSibling) parts.push(el);
  return parts;
}

/**
 * Watches the message of Claude's at `nth` on the page (by default the next one it draws) and the
 * row it arrived in, every frame, until nothing in that row has moved for two frames running after
 * its words are whole, and says when each part played: its words (from the first word's settle to
 * the last's end), each card and each line attached under it, by its text, and a held request's
 * card after the row ("held card"), which is still coming while it waits its turn (`aria-busy`). A
 * part attached late is watched too, as long as it comes before the row is still. Start it before
 * the reply can arrive.
 */
export function watchSequence(nth: number = document.querySelectorAll('.cd-claude-message').length): Promise<Played[]> {
  const played = new Map<Animation, Played>();
  const started = performance.now();
  let still = 0;
  return new Promise((resolve, reject) => {
    const step = () => {
      const message = document.querySelectorAll('.cd-claude-message')[nth];
      const row = message?.closest('.cd-transcript-row');
      if (message && row) {
        const following = after(row);
        // After the row, only a held card's own motion: what is inside it (its waiting dot, say) isn't a part.
        const heldMotion = following.flatMap((el) => el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && PARTS[a.animationName] === 'held'));
        for (const animation of [...row.getAnimations({ subtree: true }), ...heldMotion]) {
          const kind = animation instanceof CSSAnimation ? PARTS[animation.animationName] : undefined;
          const target = (animation.effect as KeyframeEffect | null)?.target;
          if (kind === undefined || !target || animation.startTime === null || played.has(animation)) continue;
          const { delay = 0, activeDuration = 0 } = animation.effect?.getComputedTiming() ?? {};
          const start = Number(animation.startTime) + delay;
          const cards = [...message.querySelectorAll(':scope > .cd-reply-card')];
          const part =
            kind === 'words' ? 'words' : kind === 'card' ? `card ${cards.indexOf(target) + 1}` : kind === 'held' ? 'held card' : `line ${target.textContent ?? ''}`;
          played.set(animation, { part, start, end: start + Number(activeDuration) });
        }
        const waiting = following.some((el) => el.getAttribute('aria-busy') === 'true');
        const moving = [...row.getAnimations({ subtree: true }), ...heldMotion].some((animation) => animation.playState === 'running');
        still = message.classList.contains('cd-claude-message--revealing') || moving || waiting ? 0 : still + 1;
        if (still >= 2) {
          // The words are one part, from the first word's settle to the last's end.
          const words = [...played.values()].filter(({ part }) => part === 'words');
          const rest = [...played.values()].filter(({ part }) => part !== 'words');
          const whole = words.length === 0 ? [] : [{ part: 'words', start: Math.min(...words.map((w) => w.start)), end: Math.max(...words.map((w) => w.end)) }];
          resolve([...whole, ...rest].sort((a, b) => a.start - b.start));
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
 * The reply's parts played strictly one after another, as `parts` names them in order (a line by
 * its text): each started no earlier than the one before it ended, so no two ever played at once.
 */
export function expectInSequence(played: readonly Played[], parts: readonly string[]): void {
  expect(played.map(({ part }) => part)).toEqual(parts);
  for (const [index, part] of played.entries()) {
    const before = played[index - 1];
    // A hundredth of a millisecond for the clock's rounding.
    if (before !== undefined) expect(part.start, `${part.part} starts once ${before.part} has ended`).toBeGreaterThanOrEqual(before.end - 0.01);
  }
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
