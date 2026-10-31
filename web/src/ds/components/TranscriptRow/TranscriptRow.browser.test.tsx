/**
 * A row that arrived live, under prefers-reduced-motion: reduce, which this project's browser
 * context emulates. The LiveReply story runs with its play, so its reduced-motion branch is the one
 * checked: the reply and its receipts show at once. And `live` is read once, when the row is first
 * drawn, so a re-render neither replays nor cuts the motion.
 */
import { composeStory } from '@storybook/react-vite';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import meta, { LiveReply } from './TranscriptRow.stories.tsx';
import { TranscriptRow } from './TranscriptRow.tsx';

it('live_reply_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(LiveReply, meta);
  await story.run();

  const row = document.querySelector('.cd-transcript-row--live');
  expect(row).not.toBeNull();
  for (const el of [row, ...(row?.querySelectorAll('*') ?? [])]) {
    if (el) expect(getComputedStyle(el).animationName).toBe('none');
  }
});

it('live_is_read_once', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    root.unmount();
    host.remove();
  });
  const draw = (live: boolean | undefined, text: string) =>
    flushSync(() =>
      root.render(
        <TranscriptRow key={text} live={live}>
          <VisitorMessage text={text} />
        </TranscriptRow>,
      ),
    );
  const isLive = () => host.querySelector('.cd-transcript-row')?.classList.contains('cd-transcript-row--live');

  // Drawn live, it stays so through a re-render that clears the flag: the motion isn't cut short.
  draw(true, 'Arrived live');
  expect(isLive()).toBe(true);
  draw(false, 'Arrived live');
  expect(isLive()).toBe(true);

  // Drawn still, as a row read from history is, it never starts moving later.
  draw(undefined, 'Read from history');
  expect(isLive()).toBe(false);
  draw(true, 'Read from history');
  expect(isLive()).toBe(false);
});
