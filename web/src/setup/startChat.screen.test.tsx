/**
 * Pressing "Start" on setup's first page puts the owner in the conversation at once: setup's chat,
 * with their own words as their first message and Claude's writing dots where its first message
 * will be, while the start runs underneath. Its answer swaps the interview in at its own address,
 * in the same place; a start that fails says so in the chat, where the dots were.
 */
import { http } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { reduceMotion } from '../ds/test/reducedMotion.ts';
import { worker } from '../mocks/browser.ts';
import { holdNextStart } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { SETUP_COPY, setupStartLostLine, setupStartSlowLine, setupStartSpentLine } from './copy.ts';

const DESCRIPTION =
  "Turner Plumbing. I'm Mike, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops. Weekdays mostly, emergencies on Saturday mornings.";

/** The idempotency key of each start the mock answered, in order. */
const startKeys = () =>
  mockStore.requests.filter((r) => r.key === 'startSetup').map((r) => (r.body as { idempotency_key?: string }).idempotency_key);

/** The next start's POST waits, unanswered, until `release`, then goes on to the mock. */
function holdStart(): () => void {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.post(
      '/api/owner/setup',
      async () => {
        await gate;
        return undefined;
      },
      { once: true },
    ),
  );
  return release;
}

/** Setup's chat, by its conversation's name, and the owner's own words in it. */
const conversation = (screen: RenderResult) => screen.getByRole('log', { name: SETUP_COPY.questions.conversation });
const ownWords = (screen: RenderResult) => conversation(screen).getByText(DESCRIPTION, { exact: true });

/** What the page shows at a commit: the start's form, setup's chat, and what the chat holds. */
interface Frame {
  form: boolean;
  chat: boolean;
  /** The owner's words, the chat's first message. */
  words: boolean;
  /** Claude's writing dots, the memory question, or a line saying the start didn't settle. */
  next: boolean;
}

/** Every commit's frame from now until the test ends, in order. */
function watchFrames(): () => Frame[] {
  const frames: Frame[] = [];
  const record = () => {
    const chat = document.querySelector('.cd-setup-chat');
    const first = chat?.querySelector('[role="log"] .cd-visitor-message__bubble');
    frames.push({
      form: document.querySelector('.cd-setup-start__field') !== null,
      chat: chat !== null,
      words: first?.textContent === DESCRIPTION,
      next: chat?.querySelector('.cd-writing-indicator, .cd-setup-question-panel, .cd-notice') != null,
    });
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return () => [...frames];
}

/** A start that didn't settle: its line in the chat where the dots were, under the owner's words, with "Try again". */
async function expectLineInChat(screen: RenderResult, line: string): Promise<void> {
  const notice = screen.getByRole('alert').filter({ hasText: line });
  await expect.element(notice).toBeVisible();
  await expect.element(notice.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect.element(ownWords(screen)).toBeVisible();
  expect(screen.getByText('Claude is writing').elements()).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'Your business' }).elements()).toHaveLength(0);
  const words = ownWords(screen).element().getBoundingClientRect();
  expect(notice.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(words.bottom);
}

describe('setup start', () => {
  it.each(['desktop', 'phone'] as Viewport[])('start_opens_the_chat_at_once_then_swaps_the_interview_in at %s', async (viewport) => {
    const release = holdStart();
    const { screen, router } = await renderRoute('/app/setup', { viewport });
    await screen.getByRole('textbox', { name: 'Your business' }).fill(DESCRIPTION);
    const frames = watchFrames();
    await screen.getByRole('button', { name: 'Start' }).click();

    // At once, before the start answers: setup's chat, the owner's words as their first message and
    // Claude's writing dots under them, at the start page's own address.
    await expect.element(screen.getByRole('heading', { level: 1, name: SETUP_COPY.questions.title })).toBeVisible();
    await expect.element(ownWords(screen)).toBeVisible();
    await expect.element(conversation(screen).getByText('Claude is writing')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your business' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Start' }).elements()).toHaveLength(0);
    expect(router.state.location.pathname).toBe('/app/setup');
    expect(startKeys()).toHaveLength(0);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
    const before = ownWords(screen).element().getBoundingClientRect();

    // The interview swaps in at its own address, which replaces the start page's: the memory
    // question where the dots were, the owner's words where they were.
    release();
    await expect.element(screen.getByRole('button', { name: 'Yes, use it' })).toBeVisible();
    expect(router.state.location.pathname).toMatch(/^\/app\/setup\/setup-\d+$/);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.getByText('Claude is writing').elements()).toHaveLength(0);
    const after = ownWords(screen).element().getBoundingClientRect();
    for (const side of ['top', 'left', 'width', 'height'] as const) {
      expect(Math.abs(after[side] - before[side]), `the owner's words' ${side}: ${before[side]}, then ${after[side]}`).toBeLessThanOrEqual(1);
    }
    expect(startKeys()).toHaveLength(1);

    // No commit from the press on draws the form again, or a chat without the owner's words or
    // without what comes next.
    const drawn = frames();
    const fromChat = drawn.slice(drawn.findIndex((frame) => frame.chat));
    expect(fromChat.length).toBeGreaterThan(0);
    expect(fromChat.filter((frame) => frame.form || !frame.chat || !frame.words || !frame.next)).toEqual([]);
  });

  it('a_start_that_did_not_settle_says_so_in_the_chat_where_the_dots_were', async () => {
    const { screen, router } = await renderRoute('/app/setup');
    await screen.getByRole('textbox', { name: 'Your business' }).fill(DESCRIPTION);
    const end = holdNextStart(mockStore.world);
    await screen.getByRole('button', { name: 'Start' }).click();

    // Its answer lost: the retry-safe line, and "Try again" sends the same start with the same key.
    await expectLineInChat(screen, setupStartLostLine());
    await screen.getByRole('button', { name: 'Try again' }).click();
    // Still under way after the page's own retries: the slow line, "Try again" the same key again.
    await expectLineInChat(screen, setupStartSlowLine());
    expect(screen.getByText(setupStartLostLine()).elements()).toHaveLength(0);
    // Its key spent: its line, and "Try again" starts anew, with a new key.
    end('spent');
    await screen.getByRole('button', { name: 'Try again' }).click();
    await expectLineInChat(screen, setupStartSpentLine());
    expect(router.state.location.pathname).toBe('/app/setup');
    await screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(screen.getByRole('button', { name: 'Yes, use it' })).toBeVisible();
    await expect.element(ownWords(screen)).toBeVisible();

    const keys = startKeys();
    expect(keys).toHaveLength(7);
    expect(new Set(keys.slice(0, 6)).size).toBe(1);
    expect(keys[6]).not.toBe(keys[0]);
    expect(mockStore.requests.filter((r) => r.key === 'startSetup').map((r) => (r.body as { description: string }).description)).toEqual(
      Array(7).fill(DESCRIPTION),
    );
  });

  it('a_refused_start_gives_the_words_back_to_the_form', async () => {
    // A clear refusal started nothing, and its line asks the owner to check their words: the form
    // again, with the words as they were, its line, and "Start", which sends a new key.
    const { screen } = await renderRoute('/app/setup');
    await screen.getByRole('textbox', { name: 'Your business' }).fill(DESCRIPTION);
    mockStore.inject({ route: 'startSetup', status: 422, body: { error: 'invalid' } });
    await screen.getByRole('button', { name: 'Start' }).click();
    await expect.element(screen.getByText("That didn't go through. Check it and try again.", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Your business' })).toHaveValue(DESCRIPTION);
    await expect.element(screen.getByRole('textbox', { name: 'Your business' })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('log', { name: SETUP_COPY.questions.conversation }).elements()).toHaveLength(0);
    await screen.getByRole('button', { name: 'Start' }).click();
    await expect.element(screen.getByRole('button', { name: 'Yes, use it' })).toBeVisible();
    const keys = startKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it.each([false, true])('the_chat_comes_in_with_one_fade_or_at_once_under_reduced_motion (reduced: %s)', async (reduced) => {
    await reduceMotion(reduced);
    onTestFinished(() => reduceMotion(false));
    const release = holdStart();
    const { screen } = await renderRoute('/app/setup');
    await screen.getByRole('textbox', { name: 'Your business' }).fill(DESCRIPTION);
    await screen.getByRole('button', { name: 'Start' }).click();
    await expect.element(ownWords(screen)).toBeVisible();

    // The transition is the chat's own entrance, in one place: a fade over motion-base, or none.
    const chat = document.querySelector('.cd-setup-start-transition');
    expect(chat).not.toBeNull();
    const style = getComputedStyle(chat!);
    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (reduced) {
      expect(style.animationName).toBe('none');
      expect(chat!.getAnimations()).toEqual([]);
    } else {
      expect(style.animationName).toBe('cd-setup-start-enter');
      expect(parseFloat(style.animationDuration) * 1000).toBe(parseFloat(token('--motion-base')));
      expect(style.animationTimingFunction).toBe(token('--motion-ease'));
    }

    // The interview draws still, in the transition's place.
    release();
    await expect.element(screen.getByRole('button', { name: 'Yes, use it' })).toBeVisible();
    expect(document.querySelector('.cd-setup-start-transition')).toBeNull();
    expect(getComputedStyle(document.querySelector('.cd-setup-chat')!).animationName).toBe('none');
  });
});
