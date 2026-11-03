/**
 * ClaudeMessage revealed, in a real browser: a reply that arrived live shows its words first, word
 * by word, and its cards only once the words are whole, then one by one; from history, or under
 * reduced motion, which this project's browser context emulates by default, it shows whole at once.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { proseBlock, rivera } from '../../fixtures/index.ts';
import { motion } from '../../test/reducedMotion.ts';
import { ClaudeMessage } from './ClaudeMessage.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;

afterEach(() => {
  if (mounted !== null) {
    const { root, host } = mounted;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    host.remove();
    mounted = null;
  }
  vi.useRealTimers();
});

/** Moves the faked clock, frames included, and lets React draw what they changed. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders `ui` into a fresh host on the page and returns the message. */
function mount(ui: ReactElement): HTMLElement {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  mounted = { root, host };
  const message = host.querySelector<HTMLElement>('.cd-claude-message');
  if (message === null) throw new Error('no message drawn');
  return message;
}

/** Renders `ui` again into the mounted host, as a parent passing new props would. */
function rerender(ui: ReactElement): void {
  if (mounted === null) throw new Error('nothing mounted');
  const { root } = mounted;
  act(() => root.render(ui));
}

/** The words the message shows, block by block. */
function words(message: HTMLElement): string[] {
  return [...message.querySelectorAll('.cd-md')].map((md) => md.textContent ?? '');
}

/** The message's cards, in order. */
function cards(message: HTMLElement): HTMLElement[] {
  return [...message.querySelectorAll<HTMLElement>(':scope > .cd-reply-card')];
}

/** How each card comes in: shown or not, and its fade's name, length and delay. */
function arrivals(message: HTMLElement) {
  return cards(message).map((card) => {
    const style = getComputedStyle(card);
    return { visibility: style.visibility, name: style.animationName, duration: style.animationDuration, delay: style.animationDelay };
  });
}

/** About 100 characters: half a second at the reveal's pace. */
const WORDS = 'Drain clearing is one visit. Here is the quote, and the times Mike has open this week for it.';
const QUOTE = rivera.blocks.quote.en;
const TIMES = rivera.blocks.booking_options.en;
const OWNER = rivera.business.ownerName;

it('revealed_cards_wait_for_the_words_then_fade_in_one_by_one', async () => {
  await motion();
  vi.useFakeTimers();
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE, TIMES]} language="en" ownerName={OWNER} reveal />);

  // The words come first, from the first one; the cards wait, unseen, in their places.
  expect(words(message)).toEqual(['Drain']);
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['hidden', 'hidden']);
  await pass(250);
  expect(words(message)[0]?.length).toBeLessThan(WORDS.length);
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['hidden', 'hidden']);

  // Once the words are whole, the cards fade and rise in, in order, a beat apart, each over motion-base.
  await pass(500);
  expect(words(message)).toEqual([WORDS]);
  expect(arrivals(message)).toEqual([
    { visibility: 'visible', name: 'cd-claude-message-follow', duration: '0.2s', delay: '0.2s' },
    { visibility: 'visible', name: 'cd-claude-message-follow', duration: '0.2s', delay: '0.4s' },
  ]);
});

it('cards_with_no_words_before_them_fade_in_at_once', async () => {
  await motion();
  const message = mount(<ClaudeMessage blocks={[QUOTE, TIMES]} language="en" ownerName={OWNER} reveal />);
  expect(arrivals(message).map(({ visibility, delay }) => ({ visibility, delay }))).toEqual([
    { visibility: 'visible', delay: '0s' },
    { visibility: 'visible', delay: '0.2s' },
  ]);
  // Busy until the cards are in.
  expect(message.getAttribute('aria-busy')).toBe('true');
});

it('prose_blocks_are_revealed_one_after_another', async () => {
  await motion();
  vi.useFakeTimers();
  const second = 'The times are in the card under this.';
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE, proseBlock(second), TIMES]} language="en" ownerName={OWNER} reveal />);
  // The second block waits for the first's words, and the cards for both.
  expect(words(message)).toEqual(['Drain']);
  await pass(700);
  expect(words(message)[0]).toBe(WORDS);
  expect(words(message)[1]?.length).toBeLessThan(second.length);
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['hidden', 'hidden']);
  await pass(400);
  expect(words(message)).toEqual([WORDS, second]);
  expect(arrivals(message).map(({ visibility, delay }) => ({ visibility, delay }))).toEqual([
    { visibility: 'visible', delay: '0.2s' },
    { visibility: 'visible', delay: '0.4s' },
  ]);
});

it('from_history_a_message_shows_whole_with_its_cards_still', async () => {
  await motion();
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE, TIMES]} language="en" ownerName={OWNER} />);
  expect(words(message)).toEqual([WORDS]);
  expect(arrivals(message).map(({ visibility, name }) => ({ visibility, name }))).toEqual([
    { visibility: 'visible', name: 'none' },
    { visibility: 'visible', name: 'none' },
  ]);
  expect(message.getAnimations({ subtree: true })).toHaveLength(0);
});

it('under_reduced_motion_a_revealed_message_shows_whole_with_its_cards_still', () => {
  // This project's browser context emulates reduced motion.
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE, TIMES]} language="en" ownerName={OWNER} reveal />);
  expect(words(message)).toEqual([WORDS]);
  expect(arrivals(message).map(({ visibility, name }) => ({ visibility, name }))).toEqual([
    { visibility: 'visible', name: 'none' },
    { visibility: 'visible', name: 'none' },
  ]);
  expect(message.getAnimations({ subtree: true })).toHaveLength(0);
  expect(message.getAttribute('aria-busy')).toBeNull();
});

it('reveal_is_read_once', async () => {
  await motion();
  vi.useFakeTimers();
  const blocks = [proseBlock(WORDS), QUOTE];
  // Drawn revealed, a re-render that clears it neither cuts the words short nor shows the cards early.
  const message = mount(<ClaudeMessage blocks={blocks} language="en" ownerName={OWNER} reveal />);
  rerender(<ClaudeMessage blocks={blocks} language="en" ownerName={OWNER} />);
  expect(words(message)).toEqual(['Drain']);
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['hidden']);
  await pass(700);
  expect(words(message)).toEqual([WORDS]);
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['visible']);
});

it('drawn_whole_it_is_never_revealed_later', async () => {
  await motion();
  const blocks = [proseBlock(WORDS), QUOTE];
  const message = mount(<ClaudeMessage blocks={blocks} language="en" ownerName={OWNER} />);
  rerender(<ClaudeMessage blocks={blocks} language="en" ownerName={OWNER} reveal />);
  expect(words(message)).toEqual([WORDS]);
  expect(arrivals(message).map(({ visibility, name }) => ({ visibility, name }))).toEqual([{ visibility: 'visible', name: 'none' }]);
});

it('until_everything_has_come_in_the_message_is_busy', async () => {
  await motion();
  vi.useFakeTimers();
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE]} language="en" ownerName={OWNER} reveal />);
  // Assistive technology may wait for the whole reply rather than read it out word by word.
  expect(message.getAttribute('aria-busy')).toBe('true');
  // The words are whole, but the card is still coming in and the words are drawn once more after
  // they settle: still busy, so the reply isn't read out twice or in pieces.
  await pass(700);
  expect(words(message)).toEqual([WORDS]);
  expect(message.getAttribute('aria-busy')).toBe('true');
  // The browser's own clock plays the settle and the fade from here, outside act().
  vi.useRealTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  await vi.waitFor(() => expect(message.classList.contains('cd-claude-message--following')).toBe(false));
  expect(message.getAttribute('aria-busy')).toBeNull();
  expect(message.querySelectorAll('[data-sd-animate]')).toHaveLength(0);
});

it('the_cards_fade_in_once', async () => {
  await motion();
  const message = mount(<ClaudeMessage blocks={[QUOTE, TIMES]} language="en" ownerName={OWNER} reveal />);
  expect(message.classList.contains('cd-claude-message--following')).toBe(true);
  // The browser's own clock plays the fade from here, outside act().
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  // Once the cards have come in, the message is like any other: nothing in it can fade in again.
  await vi.waitFor(() => expect(message.classList.contains('cd-claude-message--following')).toBe(false));
  expect(arrivals(message).map(({ visibility, name }) => ({ visibility, name }))).toEqual([
    { visibility: 'visible', name: 'none' },
    { visibility: 'visible', name: 'none' },
  ]);
});

/** About 1,110 characters: alone, the 3 s ceiling sets its pace. */
const BLOCK = Array.from({ length: 34 }, (_, index) => `Point ${String(index + 1).padStart(2, '0')} about the tank is here.`).join(' ');

it('a_reply_of_several_prose_blocks_takes_at_most_about_3_s_in_all', async () => {
  await motion();
  vi.useFakeTimers();
  expect(BLOCK.length).toBeGreaterThan(1050);
  const message = mount(<ClaudeMessage blocks={[proseBlock(BLOCK), proseBlock(BLOCK)]} language="en" ownerName={OWNER} reveal />);
  // The blocks share one pace, set by the whole reply: the first is done at about 1.5 s, and the
  // second at about 3 s. The clock moves a few frames at a time, so the page draws as it goes.
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) await pass(50);
  };
  await run(1400);
  expect(words(message)).toHaveLength(1);
  await run(1800);
  expect(words(message).map((block) => block.length)).toEqual([BLOCK.length, BLOCK.length]);
  expect(words(message)).toEqual([BLOCK, BLOCK]);
});

it('every_card_comes_in_on_its_own_beat', async () => {
  await motion();
  vi.useFakeTimers();
  const four = [QUOTE, TIMES, rivera.blocks.payment_link.en, rivera.blocks.document_link.en];
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), ...four]} language="en" ownerName={OWNER} reveal />);
  await pass(700);
  // However many cards there are, each starts once the one before has come in, 200 ms later.
  expect(arrivals(message).map((card) => card.delay)).toEqual(['0.2s', '0.4s', '0.6s', '0.8s']);
});

it('plain_prose_is_never_revealed', async () => {
  await motion();
  const message = mount(<ClaudeMessage blocks={[proseBlock(WORDS), QUOTE]} language="en" ownerName={OWNER} plainProse reveal />);
  // The Vision pages' words as written, whole, their cards with them.
  expect(message.textContent).toContain(WORDS);
  expect(message.className).toBe('cd-claude-message');
  expect(message.getAttribute('aria-busy')).toBeNull();
  expect(arrivals(message).map(({ visibility, name }) => ({ visibility, name }))).toEqual([{ visibility: 'visible', name: 'none' }]);
});

it('where_the_browser_cant_list_animations_a_revealed_message_settles_at_once', async () => {
  await motion();
  const getAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { value: undefined, configurable: true });
  onTestFinished(() => {
    if (getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', getAnimations);
  });
  // With nothing to wait on, its cards are shown and it is like any other message from the start.
  const message = mount(<ClaudeMessage blocks={[QUOTE, TIMES]} language="en" ownerName={OWNER} reveal />);
  expect(message.className).toBe('cd-claude-message');
  expect(message.getAttribute('aria-busy')).toBeNull();
  expect(arrivals(message).map((card) => card.visibility)).toEqual(['visible', 'visible']);
});

it('a_revealed_reply_s_link_shows_its_words_without_markdown_marks_in_every_frame', async () => {
  await motion();
  vi.useFakeTimers();
  const text = 'Mike keeps her hours up to date. You can see them on [our website](https://turnerplumbing.example/hours), with the holidays too.';
  const message = mount(<ClaudeMessage blocks={[proseBlock(text)]} language="en" ownerName={OWNER} reveal />);
  // Every frame of the reveal: no raw link marks or address, only words.
  const frames = [words(message)[0] ?? ''];
  for (let elapsed = 0; elapsed < 900; elapsed += 16) {
    await pass(16);
    frames.push(words(message)[0] ?? '');
  }
  for (const frame of frames) {
    expect(frame).not.toMatch(/\[|\]\(/);
    expect(frame).not.toContain('https://turnerplumbing.example/hours');
  }
  expect(frames.length).toBeGreaterThan(5);
  // Whole, the link shows its words and opens in a new tab.
  expect(frames.at(-1)).toBe('Mike keeps her hours up to date. You can see them on our website, with the holidays too.');
  expect(message.querySelectorAll('a')).toHaveLength(1);
  const link = message.querySelector('a');
  expect(link?.textContent).toBe('our website');
  expect(link?.getAttribute('href')).toBe('https://turnerplumbing.example/hours');
  expect(link?.getAttribute('target')).toBe('_blank');
  expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
});
