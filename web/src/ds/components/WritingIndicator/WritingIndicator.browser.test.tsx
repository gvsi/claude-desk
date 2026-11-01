/**
 * Claude's writing dots and a person's typing dots, with motion and under reduced motion, which
 * this project's browser context emulates by default. The ReducedMotion and PersonReducedMotion stories run with
 * their plays, so their reduced-motion branches are checked: Claude's dots stay still in clay,
 * a person's in text-secondary, and who is typing is still said.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it, onTestFinished } from 'vitest';
import { cdp } from 'vitest/browser';

import { motion } from '../../test/reducedMotion.ts';
import { WritingIndicator } from './WritingIndicator.tsx';
import meta, { PersonReducedMotion, ReducedMotion } from './WritingIndicator.stories.tsx';

/** Resolve a color token through the browser, just as the dots' background is resolved. */
function tokenColor(name: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `var(--${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

/** Force the visitor's high-contrast colors, restoring the project's reduced-motion setting after. */
async function forceColors(reducedMotion: 'reduce' | 'no-preference'): Promise<void> {
  const emulate = async (forced: 'active' | 'none'): Promise<void> => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'forced-colors', value: forced },
        { name: 'prefers-reduced-motion', value: forced === 'active' ? reducedMotion : 'reduce' },
      ],
    });
  };
  await emulate('active');
  onTestFinished(() => emulate('none'));
  expect(window.matchMedia('(forced-colors: active)').matches).toBe(true);
}

it.each(['reduce', 'no-preference'] as const)('claude_person_and_bubble_dots_remain_visible_in_forced_colors_with_motion_%s', async (reducedMotion) => {
  await forceColors(reducedMotion);
  const story = composeStory({
    render: () => <>
      <WritingIndicator language="en" />
      <WritingIndicator language="en" variant="person" who="Mike Turner" />
      <WritingIndicator language="en" variant="bubble" who="Dana" />
    </>,
  }, meta);
  await story.run();

  const pageBackground = getComputedStyle(document.body).backgroundColor;
  for (const variant of ['claude', 'person', 'bubble']) {
    const dots = [...document.querySelectorAll<HTMLElement>(`.cd-writing-indicator--${variant} .cd-writing-indicator__dot`)];
    expect(dots).toHaveLength(3);
    for (const [index, dot] of dots.entries()) {
      // Check the color pulse's peak too: keyframes must not turn the dots back into Canvas.
      const animation = dot.getAnimations()[0];
      if (animation) {
        animation.pause();
        animation.currentTime = 800 + index * 150;
      }
      expect(getComputedStyle(dot).backgroundColor).not.toBe(pageBackground);
    }
  }
});

it('claude_dots_bounce_in_clay_with_stagger_without_changing_the_reply_box', async () => {
  await motion();
  const story = composeStory({ args: { language: 'en' } }, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('.cd-writing-indicator--claude') as HTMLElement;
  const dots = status.querySelector<HTMLElement>('.cd-writing-indicator__dots') as HTMLElement;
  const each = [...dots.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(each).toHaveLength(3);
  const tokens = getComputedStyle(status);
  const duration = Number.parseFloat(tokens.getPropertyValue('--motion-dots'));
  const stagger = Number.parseFloat(tokens.getPropertyValue('--motion-stagger'));
  const lift = Number.parseFloat(tokens.getPropertyValue('--space-4'));
  expect(duration).toBe(1200);
  const box = status.getBoundingClientRect();
  const line = Number.parseFloat(tokens.lineHeight);
  expect(box.height).toBe(line);
  const animations = each.map((dot, index) => {
    const style = getComputedStyle(dot);
    expect(style.backgroundColor).toBe(tokenColor('clay'));
    expect(style.animationName).toBe('cd-writing-bounce');
    expect(style.animationDuration).toBe(`${duration / 1000}s`);
    expect(style.animationTimingFunction).toBe(tokens.getPropertyValue('--motion-ease-bounce').trim());
    expect(style.animationDelay).toBe(`${index * stagger / 1000}s`);
    expect(style.animationIterationCount).toBe('infinite');
    expect(style.width).toBe(tokens.getPropertyValue('--size-dot').trim());
    expect(style.height).toBe(style.width);
    const animation = dot.getAnimations()[0];
    if (!animation) throw new Error('Claude’s dot has no bounce animation');
    animation.pause();
    return animation;
  });
  expect(getComputedStyle(dots).gap).toBe(tokens.getPropertyValue('--space-4').trim());

  // Seek real CSS animations: rest, the 4 px peak, return, and the next loop.
  for (const [fraction, offset] of [[0, 0], [0.3, -lift], [0.6, 0], [1, 0]] as const) {
    for (const [index, animation] of animations.entries()) {
      animation.currentTime = duration * fraction + index * stagger;
    }
    expect(status.getBoundingClientRect().height).toBe(box.height);
    expect(status.getBoundingClientRect().top).toBe(box.top);
    expect(dots.getBoundingClientRect().height).toBe(line);
    for (const dot of each) {
      const style = getComputedStyle(dot);
      expect(new DOMMatrixReadOnly(style.transform).m42).toBeCloseTo(offset, 4);
      expect(style.backgroundColor).toBe(tokenColor('clay'));
      const dotBox = dot.getBoundingClientRect();
      expect(dotBox.top + dotBox.height / 2).toBeCloseTo(box.top + line / 2 + offset, 4);
    }
  }
});

it('claude_writing_shows_only_three_dots_in_one_reply_line_and_announces_the_words', async () => {
  const story = composeStory({ args: { language: 'en' } }, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
  expect(status.textContent).toBe('Claude is writing');
  expect(status.lang).toBe('en');
  expect(status).toHaveClass('cd-writing-indicator--claude', 'cd-type-reply');
  const words = status.querySelector<HTMLElement>('.cd-sr-only') as HTMLElement;
  expect(words?.textContent).toBe('Claude is writing');
  expect(getComputedStyle(words).position).toBe('absolute');
  expect(words.getBoundingClientRect().width).toBe(1);
  const dots = status.querySelector<HTMLElement>('.cd-writing-indicator__dots') as HTMLElement;
  expect(dots?.getAttribute('aria-hidden')).toBe('true');
  expect(dots.textContent).toBe('');
  expect(status.children).toHaveLength(2);
  const each = [...dots.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(each).toHaveLength(3);
  const line = Number.parseFloat(getComputedStyle(status).lineHeight);
  expect(getComputedStyle(status).fontFamily).toContain('Source Serif 4');
  expect(dots.getBoundingClientRect().height).toBe(line);
  expect(status.getBoundingClientRect().height).toBe(line);
  expect(dots.getBoundingClientRect().left).toBe(status.getBoundingClientRect().left);
  expect(getComputedStyle(status).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  for (const dot of each) {
    const box = dot.getBoundingClientRect();
    expect(box.top + box.height / 2).toBe(dots.getBoundingClientRect().top + line / 2);
    expect(getComputedStyle(dot).animationName).toBe('none');
    expect(getComputedStyle(dot).backgroundColor).toBe(tokenColor('clay'));
  }
});

it('claude_writing_announces_spanish_with_no_visible_words', async () => {
  const story = composeStory({ args: { language: 'es' } }, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
  expect(status.lang).toBe('es');
  expect(status.textContent).toBe('Claude está escribiendo');
  expect(status.querySelector('.cd-sr-only')?.textContent).toBe('Claude está escribiendo');
  const dots = status.querySelector('[aria-hidden="true"]');
  expect(dots?.textContent).toBe('');
  expect(dots?.querySelectorAll('.cd-writing-indicator__dot')).toHaveLength(3);
});

it('person_and_visitor_dots_keep_the_secondary_to_primary_pulse', async () => {
  await motion();
  const story = composeStory({
    render: () => <>
      <WritingIndicator language="en" variant="person" who="Mike Turner" />
      <WritingIndicator language="en" variant="bubble" who="Dana" />
    </>,
  }, meta);
  await story.run();

  for (const variant of ['person', 'bubble']) {
    const dots = [...document.querySelectorAll<HTMLElement>(`.cd-writing-indicator--${variant} .cd-writing-indicator__dot`)];
    expect(dots).toHaveLength(3);
    for (const [index, dot] of dots.entries()) {
      const style = getComputedStyle(dot);
      expect(style.animationName).toBe('cd-typing-dot');
      expect(style.animationDuration).toBe('1.6s');
      expect(style.animationTimingFunction).toBe('ease-out');
      expect(style.animationDelay).toBe(`${index * 0.15}s`);
      expect(style.animationIterationCount).toBe('infinite');
      const animation = dot.getAnimations()[0];
      if (!animation) throw new Error('The typing dot has no pulse animation');
      animation.pause();
      for (const [time, token] of [[0, 'text-secondary'], [800, 'text-primary'], [1600, 'text-secondary']] as const) {
        animation.currentTime = time + index * 150;
        expect(getComputedStyle(dot).backgroundColor).toBe(tokenColor(token));
        expect(getComputedStyle(dot).transform).toBe('none');
      }
    }
  }
});

it('typing_bubble_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(ReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]');
  expect(status?.textContent).toBe('Dana is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});

it('person_typing_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(PersonReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('.cd-writing-indicator--person [role="status"]');
  expect(status?.textContent).toBe('Mike Turner is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator--person .cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});
