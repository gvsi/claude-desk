/**
 * Under prefers-reduced-motion: reduce (emulated for this project's browser context), every story
 * renders with nothing animating or transitioning: no element or pseudo-element has an animation
 * name other than none or a transition duration other than 0s. Nothing is left part-drawn either: a
 * dashed stroke rests at a dash offset of 0, so a check that draws under motion is whole from the
 * start, not stopped where its draw would have begun.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { composeStory } from '@storybook/react-vite';
import { isExportStory } from 'storybook/internal/csf';
import { expect, it } from 'vitest';

const storyFiles = import.meta.glob<Record<string, unknown>>('../**/*.stories.tsx', { eager: true });

/** Everything that moves, or rests part-drawn, in the document right now, as "element: property value". */
function moving(): string[] {
  const found: string[] = [];
  for (const el of [document.documentElement, ...document.documentElement.querySelectorAll('*')]) {
    for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(el, pseudo);
      const where = `<${el.tagName.toLowerCase()}>${pseudo ?? ''}`;
      if (style.animationName.split(',').some((name) => name.trim() !== 'none')) {
        found.push(`${where}: animation-name ${style.animationName}`);
      }
      if (style.transitionDuration.split(',').some((duration) => duration.trim() !== '0s')) {
        found.push(`${where}: transition-duration ${style.transitionDuration}`);
      }
      // Strokes on the element itself: its pseudo-elements inherit the stroke but draw none.
      if (pseudo === null && style.strokeDasharray !== 'none' && style.strokeDashoffset !== '0px') {
        found.push(`${where}: part-drawn, stroke-dasharray ${style.strokeDasharray}, stroke-dashoffset ${style.strokeDashoffset}`);
      }
    }
  }
  return found;
}

it('animations_stop_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);

  const problems: string[] = [];
  let rendered = 0;
  for (const [file, exports] of Object.entries(storyFiles)) {
    const { default: meta, ...stories } = exports as { default: Meta } & Record<string, StoryObj>;
    for (const [name, story] of Object.entries(stories)) {
      if (!isExportStory(name, meta)) continue;
      // Rendered without its play (from the story or its meta), and without axe, which the
      // storybook project already runs on every story.
      const composed = composeStory(
        { ...story, play: undefined, parameters: { ...story.parameters, a11y: { ...story.parameters?.a11y, disable: true } } },
        { ...meta, play: undefined },
        undefined,
        name,
      );
      await composed.run();
      rendered += 1;
      problems.push(...moving().map((problem) => `${file} ${name}: ${problem}`));
    }
  }

  expect(rendered).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
