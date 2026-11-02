import { expect, it, onTestFinished } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { tokenColor } from '../../test/screen.ts';
import { chooseTheme } from './theme.ts';

/** Both axes overflow, as a transcript or a code block does. */
function scrollArea() {
  const area = document.createElement('div');
  area.id = 'scrollbar-probe';
  area.style.cssText = 'position: fixed; top: 100px; left: 100px; width: 200px; height: 200px; overflow: auto';
  const content = document.createElement('div');
  content.style.cssText = 'width: 1000px; height: 1000px';
  area.append(content);
  document.body.append(area);
  onTestFinished(() => area.remove());
  return area;
}

it.each(['dark', 'light'] as const)('S1_keeps_its_size_and_uses_the_theme_tokens_in_%s', async (theme) => {
  chooseTheme(theme);
  const area = scrollArea();
  await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
  if (!CSS.supports('selector(::-webkit-scrollbar)')) {
    expect(getComputedStyle(area).scrollbarWidth).toBe('thin');
    return;
  }
  const bar = () => getComputedStyle(area, '::-webkit-scrollbar');
  const thumb = () => getComputedStyle(area, '::-webkit-scrollbar-thumb');
  expect([bar().width, bar().height]).toEqual(['12px', '12px']);
  expect(getComputedStyle(area).scrollbarWidth).toBe('auto');
  expect(getComputedStyle(area).scrollbarColor).toBe('auto');
  expect(thumb().backgroundColor).toBe(tokenColor('--line-control'));
  expect(thumb().borderWidth).toBe('3px');
  expect(thumb().borderColor).toBe('rgba(0, 0, 0, 0)');
  expect(thumb().backgroundClip).toBe('padding-box');
  expect(thumb().borderRadius).toBe('999px');
  expect([thumb().minWidth, thumb().minHeight]).toEqual(['32px', '32px']);
  for (const part of ['track', 'corner']) {
    expect(getComputedStyle(area, `::-webkit-scrollbar-${part}`).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  }
  expect(getComputedStyle(area, '::-webkit-scrollbar-button').display).toBe('none');
  await userEvent.hover(page.elementLocator(area));
  await expect.poll(() => area.matches(':hover')).toBe(true);
  // Chromium's CSSOM reports the thumb's base style even while its area matches :hover.
  // Check the browser-parsed state rule and its matching host, as well as unchanged geometry.
  const hoverRule = [...document.styleSheets].flatMap(sheet => {
    try { return [...sheet.cssRules]; } catch { return []; }
  }).find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.includes(':hover::-webkit-scrollbar-thumb'))!;
  expect(area.matches(hoverRule.selectorText.split('::-webkit-scrollbar-thumb')[0]!)).toBe(true);
  expect(hoverRule.style.backgroundColor).toBe('var(--text-tertiary)');
  expect(hoverRule.selectorText).toContain('::-webkit-scrollbar-thumb:active');
  expect([bar().width, bar().height, thumb().borderWidth]).toEqual(['12px', '12px', '3px']);
});

it.each(['cd-about-paper', 'cd-vision-frame'])('About_and_vision_keep_native_scrollbars_on_the_page_and_nested_areas_at_%s', (rootClass) => {
  const area = scrollArea();
  const native = document.createElement('iframe');
  document.body.append(native);
  onTestFinished(() => native.remove());
  // An unstyled document supplies the browser's native values on this platform.
  const nativeArea = native.contentDocument!.body;
  area.classList.add(rootClass);
  const nested = area.firstElementChild!;
  for (const element of [document.documentElement, document.body, area, nested]) {
    expect(getComputedStyle(element, '::-webkit-scrollbar').width).toBe(getComputedStyle(nativeArea, '::-webkit-scrollbar').width);
    expect(getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor).toBe(getComputedStyle(nativeArea, '::-webkit-scrollbar-thumb').backgroundColor);
    expect(getComputedStyle(element).scrollbarWidth).toBe('auto');
    expect(getComputedStyle(element).scrollbarColor).toBe('auto');
  }
});
